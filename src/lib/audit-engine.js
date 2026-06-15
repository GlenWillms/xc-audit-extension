function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

export function findDiffs(current, baseline, path = 'spec') {
  const issues = [];

  if (isPlainObject(baseline)) {
    if (!isPlainObject(current)) {
      issues.push({
        path,
        type: 'TYPE_MISMATCH',
        expected: 'dict',
        found: Array.isArray(current) ? 'list' : typeof current,
      });
      return issues;
    }

    for (const [key, baseVal] of Object.entries(baseline)) {
      if (key.startsWith('__ONE_OF__')) {
        let matchedOne = false;
        for (const option of baseVal) {
          if (findDiffs(current, option, path).length === 0) {
            matchedOne = true;
            break;
          }
        }
        if (!matchedOne) {
          issues.push({
            path: `${path}.${key}`,
            type: 'NO_MATCH',
            expected: 'Allowed Config',
            found: 'None',
          });
        }
        continue;
      }

      const newPath = `${path}.${key}`;
      if (!(key in current) || current[key] == null) {
        issues.push({
          path: newPath,
          type: 'MISSING',
          expected: 'Present',
          found: 'Missing',
        });
      } else {
        issues.push(...findDiffs(current[key], baseVal, newPath));
      }
    }
  } else if (Array.isArray(baseline)) {
    if (!Array.isArray(current)) {
      issues.push({
        path,
        type: 'TYPE_MISMATCH',
        expected: 'list',
        found: typeof current,
      });
    } else {
      let match = true;
      if (baseline.length > current.length) {
        match = false;
      } else {
        for (let i = 0; i < baseline.length; i++) {
          const baseItem = baseline[i];
          const currItem = current[i];
          if (isPlainObject(baseItem)) {
            if (!Object.keys(baseItem).every((k) => currItem?.[k] === baseItem[k])) {
              match = false;
              break;
            }
          } else {
            if (baseItem !== currItem) {
              match = false;
              break;
            }
          }
        }
      }
      if (!match) {
        issues.push({
          path,
          type: 'VALUE_MISMATCH',
          expected: baseline,
          found: 'Mismatch in list content or order',
        });
      }
    }
  } else {
    if (current !== baseline) {
      issues.push({
        path,
        type: 'VALUE_MISMATCH',
        expected: baseline,
        found: current,
      });
    }
  }

  return issues;
}

export function enrichDiffs(diffs, explanations) {
  return diffs.map((d) => {
    const explanation =
      explanations[d.path] ||
      explanations[d.path.split('.').slice(0, -1).join('.')];
    return { ...d, explanation: explanation || null };
  });
}

export function applyExemptions(baselineSpec, lbLabels, exemptionMap) {
  const skipped = [];
  if (!exemptionMap || !lbLabels) return { spec: baselineSpec, skipped };

  const activeCodes = [];
  for (const code of Object.keys(exemptionMap)) {
    const labelKey = `xc-audit-${code}`;
    if (lbLabels[labelKey] === 'true' || lbLabels[labelKey] === true) {
      activeCodes.push(code);
    }
  }

  if (activeCodes.length === 0) return { spec: baselineSpec, skipped };

  const filtered = { ...baselineSpec };
  for (const code of activeCodes) {
    const entry = exemptionMap[code];
    if (!entry) continue;
    const keys = Array.isArray(entry) ? entry : entry.keys || [];
    for (const key of keys) {
      if (key in filtered) {
        delete filtered[key];
        skipped.push({ code, key, label: entry.label || code, labelKey: `xc-audit-${code}` });
      }
    }
  }
  return { spec: filtered, skipped };
}

function extractGeoCountries(policyObject) {
  const countries = new Set();
  const spec = policyObject?.spec;
  if (!spec) return countries;

  const denyList = spec.deny_list?.country_list || [];
  for (const code of denyList) countries.add(code);

  // Walk the full spec for country_list arrays in other locations
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'country_list' && Array.isArray(v)) {
        v.forEach((c) => countries.add(c));
      } else {
        walk(v);
      }
    }
  }
  walk(spec);

  return countries;
}

function extractIpThreatCategories(policyObject) {
  const categories = new Set();
  const spec = policyObject?.spec;
  if (!spec) return categories;

  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'ip_threat_categories' && Array.isArray(v)) {
        v.forEach((c) => categories.add(c));
      } else {
        walk(v);
      }
    }
  }
  walk(spec);

  return categories;
}

function collectApplicablePolicies(lb, namespace, policyConfig, referencedObjects) {
  const policies = [];
  const seen = new Set();

  // LB with active_service_policies uses only those; otherwise fall back to namespace policies
  const lbPolicies = lb.spec?.active_service_policies?.policies;
  const policyList = lbPolicies || (lb.spec?.service_policies_from_namespace !== undefined
    ? (policyConfig?.service_policies || [])
    : []);

  for (const sp of policyList) {
    if (!sp?.name) continue;
    const ns = sp.namespace || namespace;
    const key = `${ns}/${sp.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const spObject = referencedObjects.servicePolicy?.[key];
    if (spObject) policies.push({ name: sp.name, key, object: spObject });
  }

  return policies;
}

function runInspectionsForLb(lb, namespace, referencedObjects, inspectorBaselines, explanations, policyConfig) {
  const inspections = [];
  if (!referencedObjects || !inspectorBaselines) return inspections;

  // App Firewall sub-inspections
  const fwRef = lb.spec?.app_firewall;
  if (fwRef?.name) {
    const ns = fwRef.namespace || namespace;
    const fwKey = `${ns}/${fwRef.name}`;
    const fwObject = referencedObjects.appFirewall?.[fwKey];
    if (fwObject) {
      const fwSpec = fwObject.spec || fwObject;
      const wafInspectors = ['wafBlocking', 'wafThreatCampaigns', 'wafBotBlocking', 'wafAi'];
      for (const name of wafInspectors) {
        const baseline = inspectorBaselines[name];
        if (baseline && Object.keys(baseline.spec || {}).length > 0) {
          const diffs = findDiffs(fwSpec, baseline.spec, 'appfw.spec');
          inspections.push({
            inspector: name,
            categoryId: 'waf',
            refName: fwRef.name,
            pass: diffs.length === 0,
            diffs: enrichDiffs(diffs, explanations),
          });
        }
      }
    }
  }

  // Collect service policies applicable to this LB
  const applicablePolicies = collectApplicablePolicies(lb, namespace, policyConfig, referencedObjects);
  const policyNames = applicablePolicies.map((p) => p.name);

  // Geo policy inspection
  const geoBaseline = inspectorBaselines.geoPolicy;
  const requiredCountries = geoBaseline?.blocked_countries || [];
  if (requiredCountries.length > 0) {
    const allBlockedCountries = new Set();
    for (const p of applicablePolicies) {
      for (const c of extractGeoCountries(p.object)) allBlockedCountries.add(c);
    }

    const missing = requiredCountries.filter((c) => !allBlockedCountries.has(c));
    const diffs = missing.length > 0
      ? [{
          path: 'geo.blocked_countries',
          type: 'VALUE_MISMATCH',
          expected: requiredCountries.join(', '),
          found: missing.length === requiredCountries.length
            ? 'No geo-blocking rules found'
            : `Missing: ${missing.join(', ')}`,
        }]
      : [];

    inspections.push({
      inspector: 'geoPolicy',
      categoryId: 'transport',
      refName: policyNames.length ? policyNames.join(', ') : 'Service Policies',
      pass: diffs.length === 0,
      diffs: enrichDiffs(diffs, explanations),
    });
  }

  // IP Reputation inspection
  const ipRepBaseline = inspectorBaselines.ipReputation;
  const minCategories = ipRepBaseline?.min_categories ?? 10;
  if (minCategories > 0) {
    const allCategories = new Set();
    for (const p of applicablePolicies) {
      for (const c of extractIpThreatCategories(p.object)) allCategories.add(c);
    }

    const diffs = allCategories.size < minCategories
      ? [{
          path: 'iprep.categories',
          type: 'VALUE_MISMATCH',
          expected: `${minCategories}+ threat categories`,
          found: allCategories.size === 0
            ? 'No IP threat intelligence rules found'
            : `${allCategories.size} categories found`,
        }]
      : [];

    inspections.push({
      inspector: 'ipReputation',
      categoryId: 'transport',
      refName: policyNames.length ? policyNames.join(', ') : 'Service Policies',
      pass: diffs.length === 0,
      diffs: enrichDiffs(diffs, explanations),
    });
  }

  return inspections;
}

export function comparePolicies(currentPolicies, baselinePolicies) {
  const currentList = currentPolicies?.service_policies || [];
  const baselineList = baselinePolicies?.service_policies || [];

  const toKey = (p) => `${p.namespace || 'default'}/${p.name}`;
  const currentKeys = new Set(currentList.map(toKey));
  const baselineKeys = new Set(baselineList.map(toKey));

  const match = currentKeys.size === baselineKeys.size &&
    [...currentKeys].every((k) => baselineKeys.has(k));

  return { match };
}

export function runFullAudit(lbConfigs, policyConfig, baseline, explanations, exemptionMap, referencedObjects) {
  const results = { policies: null, loadBalancers: [] };
  const inspectorBaselines = baseline.inspector_baselines || {};

  if (baseline.namespace_baseline && policyConfig) {
    const diffs = findDiffs(policyConfig, baseline.namespace_baseline, 'root');
    results.policies = {
      name: 'Active Service Policies',
      pass: diffs.length === 0,
      diffs: enrichDiffs(diffs, explanations),
    };
  }

  if (baseline.lb_baseline) {
    const lbBaseSpec = baseline.lb_baseline.spec || baseline.lb_baseline;
    for (const lb of lbConfigs) {
      const labels = lb.metadata?.labels || lb.labels || {};
      const { spec: filteredSpec, skipped } = applyExemptions(lbBaseSpec, labels, exemptionMap);
      const diffSpec = {};
      for (const [k, v] of Object.entries(filteredSpec)) {
        if (!k.startsWith('__inspector__')) diffSpec[k] = v;
      }
      const currentSpec = lb.spec || {};
      const diffs = findDiffs(currentSpec, diffSpec, 'spec');

      const skippedKeys = new Set(skipped.map((s) => s.key));
      const namespace = lb.metadata?.namespace || lb.namespace;
      const allInspections = runInspectionsForLb(lb, namespace, referencedObjects, inspectorBaselines, explanations, policyConfig);
      const inspections = allInspections.filter((i) => {
        const sentinelKey = `__inspector__${i.inspector.replace(/([A-Z])/g, '_$1').toLowerCase()}`;
        return !skippedKeys.has(sentinelKey);
      });

      const warningKeys = new Set(diffs.map((d) => d.path.split('.')[1]));
      const passed = Object.keys(diffSpec)
        .filter((k) => !warningKeys.has(k))
        .map((k) => ({ key: k, path: `spec.${k}` }));

      results.loadBalancers.push({
        name: lb.metadata?.name || lb.name,
        pass: diffs.length === 0 && inspections.every((i) => i.pass),
        diffs: enrichDiffs(diffs, explanations),
        skipped,
        passed,
        inspections,
      });
    }
  }

  return results;
}

export function groupByCategory(lbResult, categories) {
  const grouped = categories.map((cat) => ({
    id: cat.id,
    label: cat.label,
    checks: cat.checks,
    passed: [],
    warnings: [],
    skipped: [],
    inspections: [],
  }));

  for (const diff of lbResult.diffs) {
    const topKey = diff.path.split('.')[1];
    const cat = grouped.find((g) => g.checks.some((c) => c.key === topKey));
    if (cat) {
      const check = cat.checks.find((c) => c.key === topKey);
      cat.warnings.push({ ...diff, required: check?.required !== false, plan: check?.plan || 'essentials' });
    }
  }

  for (const p of lbResult.passed || []) {
    const cat = grouped.find((g) => g.checks.some((c) => c.key === p.key));
    if (cat) {
      const check = cat.checks.find((c) => c.key === p.key);
      cat.passed.push({ ...p, plan: check?.plan || 'essentials' });
    }
  }

  for (const s of lbResult.skipped || []) {
    const cat = grouped.find((g) => g.checks.some((c) => c.key === s.key));
    if (cat) {
      const check = cat.checks.find((c) => c.key === s.key);
      cat.skipped.push({ ...s, plan: check?.plan || 'essentials' });
    }
  }

  for (const insp of lbResult.inspections || []) {
    const cat = grouped.find((g) => g.id === insp.categoryId);
    if (cat) {
      const check = cat.checks?.find((c) => c.inspector === insp.inspector);
      cat.inspections.push({ ...insp, plan: check?.plan || 'essentials' });
    }
  }

  for (const o of lbResult.baselineOverrides || []) {
    let targetCatId;
    if (o.inspector) {
      targetCatId = o.categoryId;
    } else if (o.path) {
      const topKey = o.path.split('.')[1];
      const matchCat = categories.find((c) => c.checks.some((ch) => ch.key === topKey));
      targetCatId = matchCat?.id;
    }
    if (!targetCatId) continue;
    let catGroup = grouped.find((g) => g.id === targetCatId);
    if (!catGroup) {
      const catDef = categories.find((c) => c.id === targetCatId);
      if (catDef) {
        catGroup = { id: catDef.id, label: catDef.label, checks: catDef.checks, passed: [], warnings: [], skipped: [], inspections: [], overrides: [] };
        grouped.push(catGroup);
      }
    }
    if (catGroup) {
      if (!catGroup.overrides) catGroup.overrides = [];
      const check = o.inspector
        ? catGroup.checks?.find((c) => c.inspector === o.inspector)
        : catGroup.checks?.find((c) => c.key === o.path?.split('.')[1]);
      catGroup.overrides.push({ ...o, plan: check?.plan || 'essentials' });
    }
  }

  return grouped.filter(
    (g) => g.passed.length || g.warnings.length || g.skipped.length || g.inspections.length || (g.overrides?.length)
  );
}

export function applyBaselineLbOverrides(results, lbConfigs, baselineLbConfigs, baselineLbReferencedObjects, baseline, explanations, defaultPolicies) {
  const inspectorBaselines = baseline.inspector_baselines || {};
  const lbBaseSpec = baseline.lb_baseline?.spec || {};

  const diffSpec = {};
  for (const [k, v] of Object.entries(lbBaseSpec)) {
    if (!k.startsWith('__inspector__')) diffSpec[k] = v;
  }

  const baselineLbAuditCache = {};

  function auditBaselineLb(baselineLbName) {
    if (baselineLbAuditCache[baselineLbName]) return baselineLbAuditCache[baselineLbName];

    const blb = baselineLbConfigs[baselineLbName];
    if (!blb) return null;

    const blbSpec = blb.spec || {};
    const blbDiffs = findDiffs(blbSpec, diffSpec, 'spec');
    const failedPaths = new Set(blbDiffs.map((d) => d.path));

    const blbNs = blb.metadata?.namespace || 'default';
    const blbInspections = runInspectionsForLb(blb, blbNs, baselineLbReferencedObjects, inspectorBaselines, explanations, defaultPolicies);
    const failedInspectors = new Set(blbInspections.filter((i) => !i.pass).map((i) => i.inspector));

    const result = { failedPaths, failedInspectors };
    baselineLbAuditCache[baselineLbName] = result;
    return result;
  }

  for (const lbResult of results.loadBalancers) {
    const lbConfig = lbConfigs.find((lb) => (lb.metadata?.name || lb.name) === lbResult.name);
    if (!lbConfig) continue;

    const labels = lbConfig.metadata?.labels || lbConfig.labels || {};
    const baselineLbName = labels['xc-audit-baseline-lb'];
    if (!baselineLbName) continue;

    const blbAudit = auditBaselineLb(baselineLbName);
    if (!blbAudit) continue;

    lbResult.baselineLb = baselineLbName;
    lbResult.baselineOverrides = [];

    const remainingDiffs = [];
    for (const diff of lbResult.diffs) {
      if (blbAudit.failedPaths.has(diff.path)) {
        lbResult.baselineOverrides.push({ ...diff, overrideStatus: 'pass' });
        const key = diff.path.split('.')[1];
        if (!lbResult.passed.find((p) => p.key === key)) {
          lbResult.passed.push({ key, path: diff.path });
        }
      } else {
        remainingDiffs.push(diff);
      }
    }
    lbResult.diffs = remainingDiffs;

    const remainingInspections = [];
    for (const insp of lbResult.inspections) {
      if (!insp.pass) {
        if (blbAudit.failedInspectors.has(insp.inspector)) {
          lbResult.baselineOverrides.push({ ...insp, overrideStatus: 'pass' });
        } else {
          remainingInspections.push(insp);
        }
      } else {
        remainingInspections.push(insp);
      }
    }
    lbResult.inspections = remainingInspections;

    const overriddenKeys = new Set(lbResult.baselineOverrides.map((o) => o.path?.split('.')[1]).filter(Boolean));
    const warningKeys = new Set(lbResult.diffs.map((d) => d.path.split('.')[1]));
    const remainingPassed = [];
    for (const p of lbResult.passed) {
      if (blbAudit.failedPaths.has(p.path || `spec.${p.key}`) && !overriddenKeys.has(p.key)) {
        lbResult.baselineOverrides.push({ ...p, overrideStatus: 'not_in_baseline' });
      } else {
        remainingPassed.push(p);
      }
    }
    lbResult.passed = remainingPassed;

    const finalInspections = [];
    for (const insp of lbResult.inspections) {
      if (insp.pass && blbAudit.failedInspectors.has(insp.inspector)) {
        lbResult.baselineOverrides.push({ ...insp, overrideStatus: 'not_in_baseline' });
      } else {
        finalInspections.push(insp);
      }
    }
    lbResult.inspections = finalInspections;

    const hasNotInBaseline = lbResult.baselineOverrides.some((o) => o.overrideStatus === 'not_in_baseline');
    lbResult.pass = lbResult.diffs.length === 0 && lbResult.inspections.every((i) => i.pass) && !hasNotInBaseline;
  }
}
