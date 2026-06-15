function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(val) {
  if (val === null || val === undefined) return String(val);
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

let _planIncludes = {};
let _planLabels = {};
let _tierLabels = {};
let _owaspCategories = {};

function initPlanData(plans, tierLabels) {
  _planIncludes = {};
  _planLabels = {};
  for (const [id, def] of Object.entries(plans || {})) {
    _planIncludes[id] = def.includes || [];
    if (def.label) _planLabels[id] = def.label;
  }
  _tierLabels = tierLabels || {};
}

function isActiveForPlan(checkPlan, plan, addons, checkKey) {
  return (_planIncludes[plan] || ['essentials']).includes(checkPlan) || addons?.includes(checkKey);
}

function planTagLabel(checkPlan) {
  return _tierLabels[checkPlan] || _planLabels[checkPlan] || null;
}

function buildRecommendations(namespaces, checkCategories, explanations) {
  const checkMap = new Map();
  for (const cat of checkCategories) {
    for (const check of cat.checks) {
      checkMap.set(check.key, { ...check, category: cat.label, categoryId: cat.id });
      if (check.inspector) checkMap.set(check.inspector, { ...check, category: cat.label, categoryId: cat.id });
    }
  }

  const findings = {};
  let totalLbs = 0;

  for (const ns of namespaces) {
    for (const lb of ns.loadBalancers) {
      totalLbs++;
      const plan = lb.result.plan || 'essentials';
      const addons = lb.result.addons || [];
      const seen = new Set();

      for (const d of lb.result.diffs || []) {
        const topKey = d.path.split('.')[1];
        const check = checkMap.get(topKey);
        if (!check) continue;
        if (!isActiveForPlan(d.plan || check.plan || 'essentials', plan, addons, check.key)) continue;
        const fKey = check.key;
        if (seen.has(fKey)) continue;
        seen.add(fKey);
        if (!findings[fKey]) {
          findings[fKey] = {
            key: fKey, count: 0, namespaces: new Set(), label: check.label,
            description: check.description, required: check.required !== false,
            category: check.category, plan: check.plan,
            owasp: check.owasp || null,
            explanation: explanations[d.path] || null,
          };
        }
        findings[fKey].count++;
        findings[fKey].namespaces.add(ns.name);
      }

      for (const insp of lb.result.inspections || []) {
        if (insp.pass) continue;
        const check = checkMap.get(insp.inspector);
        if (!check) continue;
        if (!isActiveForPlan(insp.plan || check.plan || 'essentials', plan, addons, check.key)) continue;
        const fKey = check.key;
        if (seen.has(fKey)) continue;
        seen.add(fKey);
        const explKey = insp.diffs?.[0]?.path;
        if (!findings[fKey]) {
          findings[fKey] = {
            key: fKey, count: 0, namespaces: new Set(), label: check.label,
            description: check.description, required: check.required !== false,
            category: check.category, plan: check.plan,
            owasp: check.owasp || null,
            explanation: explKey ? (explanations[explKey] || null) : null,
          };
        }
        findings[fKey].count++;
        findings[fKey].namespaces.add(ns.name);
      }
    }
  }

  const policyFailNs = namespaces.filter((ns) => ns.policies && !ns.policies.pass);
  if (policyFailNs.length) {
    findings['__policy_alignment__'] = {
      key: '__policy_alignment__', count: policyFailNs.length,
      namespaces: new Set(policyFailNs.map((ns) => ns.name)),
      label: 'Service Policy Alignment',
      description: 'Active service policies do not match the baseline in one or more namespaces.',
      required: true, category: 'Policy & Data', plan: 'essentials',
      explanation: explanations['spec.policies'] || null,
    };
  }

  return Object.values(findings)
    .sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1;
      return b.count - a.count;
    })
    .map((f) => ({ ...f, namespaces: [...f.namespaces], totalLbs }));
}

function buildOwaspSummary(namespaces, checkCategories, owaspCategories) {
  if (!owaspCategories) return '';

  const checkMap = new Map();
  for (const cat of checkCategories) {
    for (const check of cat.checks) {
      checkMap.set(check.key, check);
    }
  }

  const owaspStatus = {};
  for (const [code, meta] of Object.entries(owaspCategories)) {
    const primaryChecks = [];
    const secondaryChecks = [];
    for (const [key, check] of checkMap) {
      if (!check.owasp) continue;
      if (check.owasp.primary?.includes(code)) primaryChecks.push(check);
      if (check.owasp.secondary?.includes(code)) secondaryChecks.push(check);
    }
    owaspStatus[code] = { meta, primaryChecks, secondaryChecks, totalFailing: 0, totalChecked: 0 };
  }

  for (const ns of namespaces) {
    for (const lb of ns.loadBalancers) {
      const plan = lb.result.plan || 'essentials';
      const addons = lb.result.addons || [];
      const failingKeys = new Set();

      for (const d of lb.result.diffs || []) {
        const topKey = d.path.split('.')[1];
        const check = checkMap.get(topKey);
        if (check && isActiveForPlan(d.plan || check.plan || 'essentials', plan, addons, check.key)) {
          failingKeys.add(check.key);
        }
      }
      for (const insp of lb.result.inspections || []) {
        if (insp.pass) continue;
        for (const [, check] of checkMap) {
          if (check.inspector === insp.inspector && isActiveForPlan(insp.plan || check.plan || 'essentials', plan, addons, check.key)) {
            failingKeys.add(check.key);
          }
        }
      }

      for (const [code, entry] of Object.entries(owaspStatus)) {
        const activeChecks = entry.primaryChecks.filter(c =>
          isActiveForPlan(c.plan || 'essentials', plan, addons, c.key));
        if (activeChecks.length > 0) {
          entry.totalChecked++;
          if (activeChecks.some(c => failingKeys.has(c.key))) entry.totalFailing++;
        }
      }
    }
  }

  let rows = '';
  for (const [code, entry] of Object.entries(owaspStatus)) {
    const { meta, primaryChecks, secondaryChecks, totalFailing, totalChecked } = entry;
    let status, statusClass;

    if (meta.scope === 'out-of-scope') {
      status = 'Out of Scope';
      statusClass = 'owasp-oos';
    } else if (meta.scope === 'limited') {
      status = 'Limited';
      statusClass = 'owasp-limited';
    } else if (totalChecked === 0) {
      status = 'N/A';
      statusClass = 'owasp-oos';
    } else if (totalFailing === 0) {
      status = 'Covered';
      statusClass = 'owasp-covered';
    } else if (totalFailing < totalChecked) {
      status = 'Partial';
      statusClass = 'owasp-partial';
    } else {
      status = 'Gaps';
      statusClass = 'owasp-gaps';
    }

    const allChecks = [
      ...primaryChecks.map(c => escapeHtml(c.label)),
      ...secondaryChecks.map(c => escapeHtml(c.label) + '*'),
    ];
    const checksCell = allChecks.length > 0 ? allChecks.join(', ') : '&mdash;';
    const noteHtml = meta.note ? `<div class="owasp-note">${escapeHtml(meta.note)}</div>` : '';

    rows += `<tr>
      <td><strong>${escapeHtml(code)}</strong></td>
      <td>${escapeHtml(meta.label)}</td>
      <td class="owasp-status-cell"><span class="owasp-status ${statusClass}">${status}</span></td>
      <td class="owasp-checks-cell">${checksCell}${noteHtml}</td>
    </tr>`;
  }

  return `<div class="owasp-section">
<h3>OWASP Top 10:2025 Coverage</h3>
<table class="owasp-table">
<thead><tr><th style="width:50px">Code</th><th>Category</th><th style="width:80px;text-align:center">Status</th><th>Mapped Checks</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<div class="owasp-legend">* = secondary mapping</div>
</div>`;
}

function buildCategorySummary(namespaces, checkCategories) {
  const summary = checkCategories.map((cat) => ({
    id: cat.id, label: cat.label, pass: 0, warn: 0, skip: 0,
  }));
  const catIndex = Object.fromEntries(summary.map((s, i) => [s.id, i]));

  for (const ns of namespaces) {
    for (const lb of ns.loadBalancers) {
      for (const cat of lb.result.categorized || []) {
        const idx = catIndex[cat.id];
        if (idx === undefined) continue;
        summary[idx].pass += (cat.passed?.length || 0) + (cat.overrides?.length || 0);
        summary[idx].warn += (cat.warnings?.length || 0) +
          (cat.inspections?.filter((i) => !i.pass).length || 0);
        summary[idx].skip += cat.skipped?.length || 0;
      }
    }
  }
  return summary;
}

const TENANT_CHECK_DEFS = [
  { key: 'sso', label: 'SSO Enabled',
    description: 'Configure Single Sign-On to centralize authentication and enforce identity provider policies.',
    nextStep: 'Configure SAML or OIDC SSO under Administration → Login Options.' },
  { key: 'mfa', label: 'MFA Enforced',
    description: 'Enforce multi-factor authentication for all tenant users to prevent credential-based attacks.',
    nextStep: 'Enable mandatory MFA under Administration → Login Options → Enforce Two-Factor Authentication.' },
  { key: 'passwordPolicy', label: 'Custom Password Policy',
    description: 'Configure a password policy matching your organization\'s requirements for credential hygiene.',
    nextStep: 'Configure password policy under Administration → Tenant Settings with minimum length, complexity, and rotation requirements.' },
  { key: 'globalLogReceiver', label: 'Global Log Receiver',
    description: 'Configure a global log receiver to capture and archive security events and audit logs.',
    nextStep: 'Configure a Global Log Receiver under Shared Configuration to forward logs to your SIEM.' },
];

function buildTenantChecksSection(tenantChecks) {
  if (!tenantChecks) return '';

  let rows = '';
  for (const c of TENANT_CHECK_DEFS) {
    const result = tenantChecks[c.key];
    const status = result?.status || 'unknown';
    let statusIcon, statusClass, detail;
    if (status === 'pass') {
      statusIcon = '&#x2705;';
      statusClass = 'tenant-pass';
      detail = result.detail;
    } else if (status === 'fail') {
      statusIcon = '&#x26A0;&#xFE0F;';
      statusClass = 'tenant-warn';
      detail = result.detail;
    } else {
      statusIcon = '&#x2753;';
      statusClass = 'tenant-unknown';
      detail = 'Unable to verify — insufficient permissions or API unavailable';
    }
    rows += `<tr class="${statusClass}">
      <td>${statusIcon}</td>
      <td><strong>${escapeHtml(c.label)}</strong></td>
      <td>${escapeHtml(detail)}</td>
    </tr>`;
  }

  return `<div class="tenant-section">
<h3>Tenant Security Settings</h3>
<p class="tenant-desc">Platform-level security settings that apply across all namespaces and load balancers.</p>
<table class="tenant-table">
<thead><tr><th style="width:30px"></th><th>Setting</th><th>Status</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
}

function buildTenantRecommendations(tenantChecks) {
  if (!tenantChecks) return '';
  let html = '';
  for (const c of TENANT_CHECK_DEFS) {
    if (tenantChecks[c.key]?.status !== 'fail') continue;
    html += `<div class="rec-item rec-tenant">
      <div class="rec-header">
        <span class="rec-label">${escapeHtml(c.label)}</span>
        <span class="rec-sev rec-sev-tenant">Tenant</span>
      </div>
      <div class="rec-impact">Applies to the entire tenant</div>
      <div class="rec-desc">${escapeHtml(c.description)}</div>
      <div class="rec-action"><strong>Action:</strong> ${escapeHtml(c.nextStep)}</div>
    </div>`;
  }
  return html;
}

function owaspBadges(check) {
  if (!check?.owasp?.primary?.length) return '';
  return ' ' + check.owasp.primary.map(c => {
    const title = _owaspCategories[c]?.label || '';
    return `<span class="owasp-badge" title="${escapeHtml(title)}">${escapeHtml(c)}</span>`;
  }).join(' ');
}

function buildLbHtml(result, checkCategories) {
  const plan = result.plan || 'essentials';
  const addons = result.addons || [];
  let html = '';

  if (!result.categorized?.length) {
    if (result.diffs?.length) {
      html += `<div class="warn-list">`;
      for (const d of result.diffs) {
        html += `<div class="finding finding-warn">${escapeHtml(d.path)}`;
        if (d.type === 'MISSING') html += ' &mdash; missing';
        else html += ` &mdash; expected: <code>${escapeHtml(fmt(d.expected))}</code>, found: <code>${escapeHtml(fmt(d.found))}</code>`;
        if (d.explanation) html += `<div class="finding-reason">${escapeHtml(d.explanation.reason)}</div>`;
        html += `</div>`;
      }
      html += `</div>`;
    }
    return html;
  }

  for (const cat of result.categorized) {
    const hasContent = cat.warnings.length || cat.inspections?.length ||
      cat.passed.length || cat.skipped.length || cat.overrides?.length;
    if (!hasContent) continue;

    html += `<div class="cat-section"><div class="cat-header">${escapeHtml(cat.label)}</div>`;

    for (const d of cat.warnings) {
      const check = cat.checks?.find((c) => d.path.split('.')[1] === c.key);
      const label = check?.label || d.path;
      const isOptional = d.required === false;
      const active = isActiveForPlan(d.plan || check?.plan || 'essentials', plan, addons, check?.key);
      if (!active) {
        const tag = planTagLabel(d.plan || check?.plan);
        html += `<span class="tag tag-unavail">${escapeHtml(label)} &mdash; ${tag}</span>`;
      } else {
        html += `<div class="finding ${isOptional ? 'finding-rec' : 'finding-warn'}">`;
        if (isOptional) html += `<span class="rec-badge">Recommended</span> `;
        html += escapeHtml(label) + owaspBadges(check);
        if (d.type === 'MISSING') {
          html += isOptional ? '' : ' &mdash; missing';
        } else {
          html += ` &mdash; expected: <code>${escapeHtml(fmt(d.expected))}</code>, found: <code>${escapeHtml(fmt(d.found))}</code>`;
        }
        if (d.explanation) html += `<div class="finding-reason">${escapeHtml(d.explanation.reason)}</div>`;
        html += `</div>`;
      }
    }

    for (const insp of cat.inspections || []) {
      const inspCheck = cat.checks?.find((c) => c.inspector === insp.inspector);
      const inspLabel = inspCheck?.label || insp.refName;
      const active = isActiveForPlan(insp.plan || inspCheck?.plan || 'essentials', plan, addons, inspCheck?.key);
      if (!active) {
        const tag = planTagLabel(insp.plan || inspCheck?.plan);
        html += `<span class="tag tag-unavail">${escapeHtml(inspLabel)} &mdash; ${tag}</span>`;
      } else if (insp.pass) {
        html += `<span class="tag tag-pass">${escapeHtml(inspLabel)}${owaspBadges(inspCheck)}</span>`;
      } else {
        for (const d of insp.diffs) {
          html += `<div class="finding finding-warn">${escapeHtml(inspLabel)}${owaspBadges(inspCheck)}`;
          if (d.type === 'MISSING') html += ' &mdash; missing';
          else html += ` &mdash; expected: <code>${escapeHtml(fmt(d.expected))}</code>, found: <code>${escapeHtml(fmt(d.found))}</code>`;
          if (d.explanation) html += `<div class="finding-reason">${escapeHtml(d.explanation.reason)}</div>`;
          html += `</div>`;
        }
      }
    }

    for (const o of (cat.overrides || [])) {
      const check = o.inspector
        ? cat.checks?.find((c) => c.inspector === o.inspector)
        : cat.checks?.find((c) => c.key === o.path?.split('.')[1]);
      const label = check?.label || o.path || o.inspector;
      const active = isActiveForPlan(o.plan || check?.plan || 'essentials', plan, addons, check?.key);
      if (!active) {
        const tag = planTagLabel(o.plan || check?.plan);
        html += `<span class="tag tag-unavail">${escapeHtml(label)} &mdash; ${tag}</span>`;
      } else if (o.overrideStatus === 'not_in_baseline') {
        html += `<span class="tag tag-info">${escapeHtml(label)} &mdash; not in baseline</span>`;
      } else {
        html += `<span class="tag tag-pass">${escapeHtml(label)} &mdash; via ${escapeHtml(result.baselineLb)}</span>`;
      }
    }

    for (const s of cat.skipped) {
      const check = cat.checks?.find((c) => c.key === s.key);
      const label = check?.label || s.label;
      html += `<span class="tag tag-skip">${escapeHtml(label)}${owaspBadges(check)} &mdash; Ignored by Label</span>`;
    }

    for (const p of cat.passed) {
      const check = cat.checks?.find((c) => c.key === p.key);
      const label = check?.label || p.key;
      const active = isActiveForPlan(p.plan || check?.plan || 'essentials', plan, addons, check?.key);
      if (!active) {
        const tag = planTagLabel(p.plan || check?.plan);
        html += `<span class="tag tag-unavail">${escapeHtml(label)} &mdash; ${tag}</span>`;
      } else {
        html += `<span class="tag tag-pass">${escapeHtml(label)}${owaspBadges(check)}</span>`;
      }
    }

    if (cat.id === 'policy' && result.policyComparison) {
      const cmp = result.policyComparison;
      if (cmp.match) {
        html += `<span class="tag tag-pass">Active service policies match ${escapeHtml(cmp.baselineSource)}</span>`;
      } else {
        html += `<span class="tag tag-info">Active service policies differ from ${escapeHtml(cmp.baselineSource)}</span>`;
      }
    }

    html += `</div>`;
  }

  return html;
}

export function buildHtmlReport({ tenant, companyName, logoDataUrl, tenantChecks, namespaces, checkCategories, plans, tierLabels, owaspCategories, explanations, generatedAt, version }) {
  initPlanData(plans, tierLabels);
  _owaspCategories = owaspCategories || {};
  const displayName = companyName || tenant;
  const totalLbs = namespaces.reduce((sum, ns) => sum + ns.loadBalancers.length, 0);
  const warningLbs = namespaces.reduce(
    (sum, ns) => sum + ns.loadBalancers.filter((lb) => !lb.result.pass).length, 0
  );
  const passLbs = totalLbs - warningLbs;
  const compliancePct = totalLbs > 0 ? Math.round((passLbs / totalLbs) * 100) : 100;

  const catSummary = buildCategorySummary(namespaces, checkCategories);
  const owaspHtml = buildOwaspSummary(namespaces, checkCategories, owaspCategories);
  const recommendations = buildRecommendations(namespaces, checkCategories, explanations);

  let namespaceSections = '';
  for (const ns of namespaces.sort((a, b) => a.name.localeCompare(b.name))) {
    namespaceSections += `<div class="ns-section">`;
    namespaceSections += `<h2>${escapeHtml(ns.name)}`;
    if (ns.managedTenant) namespaceSections += ` <span class="mt-badge">${escapeHtml(ns.managedTenant)}</span>`;
    namespaceSections += `</h2>`;

    if (ns.policies) {
      namespaceSections += `<div class="policy-row ${ns.policies.pass ? 'policy-pass' : 'policy-warn'}">`;
      namespaceSections += `Service Policies: ${ns.policies.pass ? '&#x2705;' : '&#x26A0;&#xFE0F;'}`;
      if (!ns.policies.pass && ns.policies.diffs?.length) {
        namespaceSections += ` (${ns.policies.diffs.length} issue${ns.policies.diffs.length === 1 ? '' : 's'})`;
      }
      namespaceSections += `</div>`;
    }

    const nsPassCount = ns.loadBalancers.filter((lb) => lb.result.pass).length;
    const nsWarnCount = ns.loadBalancers.length - nsPassCount;
    namespaceSections += `<div class="ns-summary">${ns.loadBalancers.length} load balancer${ns.loadBalancers.length === 1 ? '' : 's'}: ${nsPassCount} passing, ${nsWarnCount} with warnings</div>`;

    for (const lb of ns.loadBalancers.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = lb.result;
      const plan = r.plan || 'essentials';
      const addons = r.addons || [];
      const activeDiffs = r.diffs.filter((d) => isActiveForPlan(d.plan || 'essentials', plan, addons, d.key));
      const activeInspections = (r.inspections || []).filter((i) => isActiveForPlan(i.plan || 'essentials', plan, addons, i.key));
      const activePassed = (r.passed || []).filter((p) => isActiveForPlan(p.plan || 'essentials', plan, addons, p.key));
      const skipCount = r.skipped?.length || 0;
      const passCount = activePassed.length;
      const recommendedCount = activeDiffs.filter((d) => d.required === false).length;
      const requiredWarningCount = activeDiffs.filter((d) => d.required !== false).length +
        activeInspections.filter((i) => !i.pass).length;

      const parts = [];
      if (passCount) parts.push(`${passCount} passed`);
      if (requiredWarningCount) parts.push(`${requiredWarningCount} warnings`);
      if (recommendedCount) parts.push(`${recommendedCount} recommended`);
      if (skipCount) parts.push(`${skipCount} skipped`);
      const refNote = r.baselineLb ? ` <span class="ref-tag">ref: ${escapeHtml(r.baselineLb)}</span>` : '';

      namespaceSections += `<details class="lb-detail ${r.pass ? 'lb-pass' : 'lb-warn'}">`;
      namespaceSections += `<summary>${r.pass ? '&#x2705;' : '&#x26A0;&#xFE0F;'} <strong>${escapeHtml(lb.name)}</strong>${refNote} (${parts.join(', ')})</summary>`;
      namespaceSections += `<div class="lb-body">${buildLbHtml(r, checkCategories)}</div>`;
      namespaceSections += `</details>`;
    }

    namespaceSections += `</div>`;
  }

  const tenantRecsHtml = buildTenantRecommendations(tenantChecks);

  let recsHtml = '';
  if (recommendations.length === 0 && !tenantRecsHtml) {
    recsHtml = `<p class="all-clear">All audited load balancers are compliant with the configured baseline. No action items at this time.</p>`;
  } else if (recommendations.length === 0) {
    recsHtml = `<p class="all-clear" style="margin-top:12px">All audited load balancers are compliant with the configured baseline.</p>`;
  } else {
    for (const rec of recommendations) {
      const nsCount = rec.namespaces.length;
      recsHtml += `<div class="rec-item">`;
      recsHtml += `<div class="rec-header">`;
      recsHtml += `<span class="rec-label">${escapeHtml(rec.label)}</span>`;
      recsHtml += `<span class="rec-sev ${rec.required ? 'rec-required' : 'rec-optional'}">${rec.required ? 'Required' : 'Recommended'}</span>`;
      if (rec.owasp?.primary?.length) {
        recsHtml += rec.owasp.primary.map(c => {
          const title = _owaspCategories[c]?.label || '';
          return ` <span class="owasp-badge" title="${escapeHtml(title)}">${escapeHtml(c)}</span>`;
        }).join('');
      }
      recsHtml += `</div>`;
      recsHtml += `<div class="rec-impact">Affects ${rec.count} of ${rec.totalLbs} load balancer${rec.totalLbs === 1 ? '' : 's'} across ${nsCount} namespace${nsCount === 1 ? '' : 's'}</div>`;
      if (rec.description) recsHtml += `<div class="rec-desc">${escapeHtml(rec.description)}</div>`;
      if (rec.explanation?.next_step) recsHtml += `<div class="rec-action"><strong>Action:</strong> ${escapeHtml(rec.explanation.next_step)}</div>`;
      recsHtml += `</div>`;
    }
  }

  const tenantSectionHtml = buildTenantChecksSection(tenantChecks);

  let tenantStatHtml = '';
  if (tenantChecks) {
    const tenantPassCount = TENANT_CHECK_DEFS.filter(c => tenantChecks[c.key]?.status === 'pass').length;
    const tenantStatClass = tenantPassCount === TENANT_CHECK_DEFS.length ? 'stat-pass' : 'stat-warn';
    tenantStatHtml = `<div class="stat-card ${tenantStatClass}"><div class="stat-value">${tenantPassCount}/${TENANT_CHECK_DEFS.length}</div><div class="stat-label">Tenant Settings</div></div>`;
  }

  let catSummaryRows = '';
  for (const cat of catSummary) {
    catSummaryRows += `<tr><td>${escapeHtml(cat.label)}</td><td class="num pass">${cat.pass}</td><td class="num warn">${cat.warn}</td><td class="num skip">${cat.skip}</td></tr>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>F5 XC Audit Report &mdash; ${escapeHtml(displayName)}</title>
<style>
:root {
  --pass-bg: #d4edda; --pass-fg: #155724;
  --warn-bg: #f8d7da; --warn-fg: #721c24;
  --skip-bg: #fff3cd; --skip-fg: #664d03;
  --rec-bg: #cfe2ff; --rec-fg: #084298;
  --info-bg: #e2e3e5; --info-fg: #41464b;
  --unavail-fg: #adb5bd;
  --border: #dee2e6;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; color: #333; max-width: 960px; margin: 0 auto; padding: 24px; background: #fff; }
h1 { font-size: 22px; margin-bottom: 4px; }
.subtitle { font-size: 13px; color: #666; margin-bottom: 24px; }
h2 { font-size: 18px; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 2px solid var(--border); }
h3 { font-size: 15px; margin: 16px 0 8px; }

.exec-summary { background: #f8f9fa; border: 1px solid var(--border); border-radius: 6px; padding: 16px; margin-bottom: 24px; }
.exec-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px; }
.stat-card { text-align: center; padding: 12px; border-radius: 6px; background: #fff; border: 1px solid var(--border); }
.stat-value { font-size: 28px; font-weight: 700; }
.stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; margin-top: 2px; }
.stat-pass .stat-value { color: var(--pass-fg); }
.stat-warn .stat-value { color: var(--warn-fg); }
.stat-pct .stat-value { color: #0d6efd; }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; }
th { font-weight: 600; background: #f8f9fa; }
td.num { text-align: center; font-weight: 600; }
td.pass { color: var(--pass-fg); }
td.warn { color: var(--warn-fg); }
td.skip { color: var(--skip-fg); }

.ns-section { margin-bottom: 28px; }
.ns-summary { font-size: 13px; color: #666; margin-bottom: 10px; }
.policy-row { font-size: 13px; padding: 4px 8px; border-radius: 4px; margin-bottom: 8px; display: inline-block; }
.policy-pass { background: var(--pass-bg); color: var(--pass-fg); }
.policy-warn { background: var(--warn-bg); color: var(--warn-fg); }

.lb-detail { margin-bottom: 6px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.lb-detail summary { padding: 8px 12px; cursor: pointer; font-size: 13px; list-style: none; }
.lb-detail summary::-webkit-details-marker { display: none; }
.lb-detail summary::before { content: '\\25B6'; display: inline-block; margin-right: 6px; font-size: 10px; transition: transform 0.15s; }
.lb-detail[open] summary::before { transform: rotate(90deg); }
.lb-pass summary { background: var(--pass-bg); color: var(--pass-fg); }
.lb-warn summary { background: var(--warn-bg); color: var(--warn-fg); }
.lb-body { padding: 8px 12px; background: #fafafa; }

.cat-section { margin-bottom: 8px; }
.cat-header { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; color: #495057; padding: 4px 0 2px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }

.finding { font-size: 12px; padding: 4px 0; border-bottom: 1px solid #f0f0f0; }
.finding:last-child { border-bottom: none; }
.finding-warn { color: var(--warn-fg); }
.finding-rec { color: var(--rec-fg); }
.finding-reason { font-size: 11px; color: #888; margin-top: 2px; font-style: italic; }

.tag { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 3px; margin: 2px 4px 2px 0; }
.tag-pass { background: var(--pass-bg); color: var(--pass-fg); }
.tag-warn { background: var(--warn-bg); color: var(--warn-fg); }
.tag-skip { background: var(--skip-bg); color: var(--skip-fg); text-decoration: line-through; }
.tag-info { background: var(--rec-bg); color: var(--rec-fg); }
.tag-unavail { background: #f8f9fa; color: var(--unavail-fg); font-style: italic; }

.rec-badge { font-size: 10px; font-weight: 600; color: var(--rec-fg); background: var(--rec-bg); padding: 1px 5px; border-radius: 3px; }
.ref-tag { font-size: 10px; color: var(--rec-fg); background: var(--rec-bg); padding: 1px 5px; border-radius: 3px; margin-left: 4px; }
.mt-badge { font-size: 12px; color: #666; font-weight: 400; }

.recs-section { margin-top: 32px; padding-top: 16px; border-top: 3px solid var(--border); }
.recs-section h2 { border-bottom: none; }
.rec-item { padding: 12px; margin-bottom: 8px; border: 1px solid var(--border); border-radius: 6px; border-left: 4px solid var(--warn-fg); }
.rec-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.rec-label { font-weight: 600; font-size: 14px; }
.rec-sev { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; }
.rec-required { background: var(--warn-bg); color: var(--warn-fg); }
.rec-optional { background: var(--rec-bg); color: var(--rec-fg); }
.rec-impact { font-size: 12px; color: #666; margin-bottom: 4px; }
.rec-desc { font-size: 13px; color: #444; margin-bottom: 4px; }
.rec-action { font-size: 13px; color: var(--pass-fg); background: var(--pass-bg); padding: 6px 10px; border-radius: 4px; }
.all-clear { color: var(--pass-fg); background: var(--pass-bg); padding: 12px; border-radius: 6px; font-size: 14px; }

.owasp-section { background: #f8f9fa; border: 1px solid var(--border); border-radius: 6px; padding: 16px; margin-bottom: 24px; }
.owasp-section h3 { margin-bottom: 10px; }
.owasp-table { font-size: 12px; }
.owasp-table td { vertical-align: top; padding: 6px 10px; }
.owasp-checks-cell { font-size: 11px; color: #555; }
.owasp-note { font-size: 10px; color: #888; font-style: italic; margin-top: 2px; }
.owasp-status { display: inline-block; font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
.owasp-covered { background: var(--pass-bg); color: var(--pass-fg); }
.owasp-partial { background: var(--skip-bg); color: var(--skip-fg); }
.owasp-gaps { background: var(--warn-bg); color: var(--warn-fg); }
.owasp-limited { background: #e2e3e5; color: #41464b; }
.owasp-oos { background: #f8f9fa; color: #adb5bd; }
.owasp-legend { font-size: 10px; color: #888; margin-top: 6px; font-style: italic; }
.owasp-badge { display: inline-block; font-size: 9px; font-weight: 600; padding: 1px 4px; border-radius: 2px; background: #e7e8ec; color: #495057; margin-left: 3px; vertical-align: middle; letter-spacing: 0.2px; }
.owasp-status-cell { text-align: center; }

.tenant-section { background: #f8f9fa; border: 1px solid var(--border); border-radius: 6px; padding: 16px; margin-bottom: 24px; }
.tenant-section h3 { margin-bottom: 4px; }
.tenant-desc { font-size: 12px; color: #666; margin-bottom: 10px; }
.tenant-table { font-size: 13px; }
.tenant-table td { vertical-align: middle; padding: 8px 10px; }
.tenant-pass td { color: var(--pass-fg); }
.tenant-warn td { color: var(--warn-fg); }
.tenant-unknown td { color: #6c757d; font-style: italic; }
.rec-tenant { border-left-color: #0d6efd; }
.rec-sev-tenant { background: var(--rec-bg); color: var(--rec-fg); }

.report-header { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 4px; }
.tenant-logo { max-height: 48px; max-width: 200px; object-fit: contain; }
.footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 11px; color: #999; text-align: center; }

@media print {
  body { padding: 0; max-width: none; }
  .lb-detail[open] summary ~ .lb-body { break-inside: avoid; }
  .rec-item { break-inside: avoid; }
  .ns-section { break-before: auto; }
  .owasp-section { break-inside: avoid; }
  .tenant-section { break-inside: avoid; }
}
</style>
</head>
<body>

<div class="report-header">
${logoDataUrl ? `<img src="${logoDataUrl}" class="tenant-logo" alt="">` : ''}
<div>
<h1>${escapeHtml(displayName)} &mdash; Security Audit Report</h1>
<div class="subtitle">Tenant: ${escapeHtml(tenant)} &mdash; Generated: ${escapeHtml(generatedAt)}${version ? ` &mdash; Extension ${escapeHtml(version)}` : ''}</div>
</div>
</div>

<div class="exec-summary">
<h3>Executive Summary</h3>
<div class="exec-grid">
  <div class="stat-card"><div class="stat-value">${namespaces.length}</div><div class="stat-label">Namespaces</div></div>
  <div class="stat-card"><div class="stat-value">${totalLbs}</div><div class="stat-label">Load Balancers</div></div>
  <div class="stat-card stat-pass"><div class="stat-value">${passLbs}</div><div class="stat-label">Passing</div></div>
  <div class="stat-card stat-warn"><div class="stat-value">${warningLbs}</div><div class="stat-label">With Warnings</div></div>
  <div class="stat-card stat-pct"><div class="stat-value">${compliancePct}%</div><div class="stat-label">Compliance</div></div>
  ${tenantStatHtml}
</div>
<table>
<thead><tr><th>Category</th><th style="text-align:center">Passed</th><th style="text-align:center">Warnings</th><th style="text-align:center">Skipped</th></tr></thead>
<tbody>${catSummaryRows}</tbody>
</table>
</div>

${owaspHtml}

${tenantSectionHtml}

${namespaceSections}

<div class="recs-section">
<h2>Recommendations</h2>
${tenantRecsHtml}${recsHtml}
</div>

<div class="footer">Generated by F5 XC Namespace Audit${version ? ` v${escapeHtml(version)}` : ''}</div>

</body>
</html>`;
}
