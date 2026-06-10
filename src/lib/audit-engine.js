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
      if (!(key in current)) {
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

export function runFullAudit(lbConfigs, policyConfig, baseline, explanations, exemptionMap) {
  const results = { policies: null, loadBalancers: [] };

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
      const currentSpec = lb.spec || {};
      const diffs = findDiffs(currentSpec, filteredSpec, 'spec');
      const failedKeys = new Set(diffs.map((d) => d.path.split('.')[1]));
      const passed = Object.keys(filteredSpec)
        .filter((k) => !failedKeys.has(k))
        .map((k) => ({ key: k, path: `spec.${k}` }));
      results.loadBalancers.push({
        name: lb.metadata?.name || lb.name,
        pass: diffs.length === 0,
        diffs: enrichDiffs(diffs, explanations),
        skipped,
        passed,
      });
    }
  }

  return results;
}
