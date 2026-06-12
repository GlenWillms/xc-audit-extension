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
        html += escapeHtml(label);
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
        html += `<span class="tag tag-pass">${escapeHtml(inspLabel)}</span>`;
      } else {
        for (const d of insp.diffs) {
          html += `<div class="finding finding-warn">${escapeHtml(inspLabel)}`;
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
      html += `<span class="tag tag-skip">${escapeHtml(label)} &mdash; Ignored by Label</span>`;
    }

    for (const p of cat.passed) {
      const check = cat.checks?.find((c) => c.key === p.key);
      const label = check?.label || p.key;
      const active = isActiveForPlan(p.plan || check?.plan || 'essentials', plan, addons, check?.key);
      if (!active) {
        const tag = planTagLabel(p.plan || check?.plan);
        html += `<span class="tag tag-unavail">${escapeHtml(label)} &mdash; ${tag}</span>`;
      } else {
        html += `<span class="tag tag-pass">${escapeHtml(label)}</span>`;
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

export function buildHtmlReport({ tenant, companyName, logoDataUrl, namespaces, checkCategories, plans, tierLabels, explanations, generatedAt, version }) {
  initPlanData(plans, tierLabels);
  const displayName = companyName || tenant;
  const totalLbs = namespaces.reduce((sum, ns) => sum + ns.loadBalancers.length, 0);
  const warningLbs = namespaces.reduce(
    (sum, ns) => sum + ns.loadBalancers.filter((lb) => !lb.result.pass).length, 0
  );
  const passLbs = totalLbs - warningLbs;
  const compliancePct = totalLbs > 0 ? Math.round((passLbs / totalLbs) * 100) : 100;

  const catSummary = buildCategorySummary(namespaces, checkCategories);
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

  let recsHtml = '';
  if (recommendations.length === 0) {
    recsHtml = `<p class="all-clear">All audited load balancers are compliant with the configured baseline. No action items at this time.</p>`;
  } else {
    for (const rec of recommendations) {
      const nsCount = rec.namespaces.length;
      recsHtml += `<div class="rec-item">`;
      recsHtml += `<div class="rec-header">`;
      recsHtml += `<span class="rec-label">${escapeHtml(rec.label)}</span>`;
      recsHtml += `<span class="rec-sev ${rec.required ? 'rec-required' : 'rec-optional'}">${rec.required ? 'Required' : 'Recommended'}</span>`;
      recsHtml += `</div>`;
      recsHtml += `<div class="rec-impact">Affects ${rec.count} of ${rec.totalLbs} load balancer${rec.totalLbs === 1 ? '' : 's'} across ${nsCount} namespace${nsCount === 1 ? '' : 's'}</div>`;
      if (rec.description) recsHtml += `<div class="rec-desc">${escapeHtml(rec.description)}</div>`;
      if (rec.explanation?.next_step) recsHtml += `<div class="rec-action"><strong>Action:</strong> ${escapeHtml(rec.explanation.next_step)}</div>`;
      recsHtml += `</div>`;
    }
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

.report-header { display: flex; align-items: center; gap: 16px; margin-bottom: 4px; }
.tenant-logo { max-height: 48px; max-width: 200px; object-fit: contain; }
.footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 11px; color: #999; text-align: center; }

@media print {
  body { padding: 0; max-width: none; }
  .lb-detail[open] summary ~ .lb-body { break-inside: avoid; }
  .rec-item { break-inside: avoid; }
  .ns-section { break-before: auto; }
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
</div>
<table>
<thead><tr><th>Category</th><th style="text-align:center">Passed</th><th style="text-align:center">Warnings</th><th style="text-align:center">Skipped</th></tr></thead>
<tbody>${catSummaryRows}</tbody>
</table>
</div>

${namespaceSections}

<div class="recs-section">
<h2>Recommendations</h2>
${recsHtml}
</div>

<div class="footer">Generated by F5 XC Namespace Audit${version ? ` v${escapeHtml(version)}` : ''}</div>

</body>
</html>`;
}
