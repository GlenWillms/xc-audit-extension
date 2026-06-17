import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runFullAudit, groupByCategory, comparePolicies, applyBaselineLbOverrides } from '../../src/lib/audit-engine.js';
import { buildHtmlReport } from '../../src/lib/report-builder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, '..', '..', 'assets');

let checkCategories = [];
let planIncludes = {};
let rawPlans = {};
let addonTiers = [];
let planMeta = { tierLabels: {}, planLabels: {}, planIncludes: {} };
let owaspCategories = {};

let defaultBaseline = null;
let defaultExplanations = null;
let defaultExemptionMap = null;

async function loadJson(filename) {
  const raw = await readFile(join(ASSETS_DIR, filename), 'utf-8');
  return JSON.parse(raw);
}

export async function loadAssets() {
  const [catData, baseline, explanations, exemptionMap] = await Promise.all([
    loadJson('check-categories.json'),
    loadJson('baseline_lb_http.json'),
    loadJson('explanations.json'),
    loadJson('exemption_map.json'),
  ]);

  checkCategories = catData.categories || [];
  owaspCategories = catData.owaspCategories || {};
  rawPlans = catData.plans || {};
  addonTiers = catData.addonTiers || [];
  planIncludes = {};
  const tierLabels = catData.tierLabels || {};
  const planLabels = {};
  const planIncludesArrays = {};
  for (const [id, def] of Object.entries(rawPlans)) {
    planIncludes[id] = new Set(def.includes || []);
    planIncludesArrays[id] = def.includes || [];
    if (def.label) planLabels[id] = def.label;
  }
  planMeta = { tierLabels, planLabels, planIncludes: planIncludesArrays };

  defaultBaseline = baseline;
  defaultExplanations = explanations;
  defaultExemptionMap = exemptionMap;
}

export function getAsset(name) {
  const map = {
    'check-categories': { categories: checkCategories, plans: rawPlans, addonTiers, tierLabels: planMeta.tierLabels, owaspCategories },
    'baseline': defaultBaseline,
    'explanations': defaultExplanations,
    'exemption-map': defaultExemptionMap,
  };
  return map[name] || null;
}

async function fetchReferencedObjects(client, lbConfigs, namespace, policies, defaultPolicies) {
  const refs = { appFirewall: {}, servicePolicy: {} };
  const fwSeen = new Map();
  const spSeen = new Map();

  for (const lb of lbConfigs) {
    const fw = lb.spec?.app_firewall;
    if (fw?.name) {
      const ns = fw.namespace || namespace;
      const key = `${ns}/${fw.name}`;
      if (!fwSeen.has(key)) fwSeen.set(key, { name: fw.name, namespace: ns });
    }
  }

  const nsPolicies = policies?.service_policies || defaultPolicies?.service_policies || [];
  for (const sp of nsPolicies) {
    if (sp?.name) {
      const ns = sp.namespace || namespace;
      const key = `${ns}/${sp.name}`;
      if (!spSeen.has(key)) spSeen.set(key, { name: sp.name, namespace: ns });
    }
  }

  for (const lb of lbConfigs) {
    const lbPolicies = lb.spec?.active_service_policies?.policies || [];
    for (const sp of lbPolicies) {
      if (sp?.name) {
        const ns = sp.namespace || namespace;
        const key = `${ns}/${sp.name}`;
        if (!spSeen.has(key)) spSeen.set(key, { name: sp.name, namespace: ns });
      }
    }
  }

  const fetches = [];

  for (const [key, ref] of fwSeen) {
    fetches.push((async () => {
      const data = await client.getAppFirewall(ref.namespace, ref.name);
      if (data) refs.appFirewall[key] = data;
    })());
  }

  for (const [key, ref] of spSeen) {
    fetches.push((async () => {
      const data = await client.getServicePolicy(ref.namespace, ref.name);
      if (data) refs.servicePolicy[key] = data;
    })());
  }

  await Promise.all(fetches);
  return refs;
}

async function fetchTenantMeta(client, managedTenant) {
  const tenantChecks = {
    sso: { status: 'unknown', detail: 'Unable to verify' },
    mfa: { status: 'unknown', detail: 'Unable to verify' },
    passwordPolicy: { status: 'unknown', detail: 'Unable to verify' },
    globalLogReceiver: { status: 'unknown', detail: 'Unable to verify' },
  };
  let companyName = null;

  const settings = await client.getTenantSettings();
  if (settings) {
    companyName = managedTenant || settings.company_name || null;

    const ssoConfig = settings.sso_config || settings.login_options?.sso_config;
    if (ssoConfig && Object.keys(ssoConfig).length > 0) {
      tenantChecks.sso = { status: 'pass', detail: 'SSO configured' };
    } else {
      tenantChecks.sso = { status: 'fail', detail: 'SSO not configured' };
    }

    const mfaEnforced = settings.mfa_required || settings.login_options?.mfa_required
      || settings.two_factor_auth?.enforced;
    if (mfaEnforced) {
      tenantChecks.mfa = { status: 'pass', detail: 'MFA enforced' };
    } else {
      tenantChecks.mfa = { status: 'fail', detail: 'MFA not enforced' };
    }
  }

  const idmSettings = await client.getTenantIdmSettings();
  if (idmSettings) {
    if (!managedTenant) {
      companyName = idmSettings.tenant_details?.display_name || companyName;
    }
    const pwPolicy = idmSettings.password_policy;
    if (pwPolicy && Object.keys(pwPolicy).length > 0) {
      tenantChecks.passwordPolicy = { status: 'pass', detail: 'Custom password policy configured' };
    } else {
      tenantChecks.passwordPolicy = { status: 'fail', detail: 'No custom password policy' };
    }
  }

  const logData = await client.getGlobalLogReceivers();
  if (logData) {
    const items = logData.items || [];
    if (items.length > 0) {
      tenantChecks.globalLogReceiver = {
        status: 'pass',
        detail: `${items.length} global log receiver${items.length === 1 ? '' : 's'} configured`,
      };
    } else {
      tenantChecks.globalLogReceiver = { status: 'fail', detail: 'No global log receivers configured' };
    }
  }

  return { companyName, logoDataUrl: null, tenantChecks };
}

export async function auditNamespace(client, namespace, tenantConfig, progress) {
  const baseline = tenantConfig.baseline || defaultBaseline;
  const explanations = tenantConfig.explanations || defaultExplanations;
  const exemptionMap = tenantConfig.exemptionMap || defaultExemptionMap;
  const plan = tenantConfig.plan || 'essentials';
  const enabledAddons = new Set(tenantConfig.addons || []);

  if (!baseline) throw new Error('No baseline configured');

  progress?.(`Fetching load balancers in ${namespace}...`);

  const [policies, defaultPolicies, lbList] = await Promise.all([
    client.getActiveServicePolicies(namespace),
    client.getActiveServicePolicies('default'),
    client.listLoadBalancers(namespace),
  ]);

  if (lbList.length === 0) {
    return { name: namespace, managedTenant: tenantConfig.managedTenant || null, policies: null, loadBalancers: [] };
  }

  progress?.(`Fetching ${lbList.length} LB configs in ${namespace}...`);

  const lbConfigs = (await Promise.all(
    lbList.map(lb => {
      const name = lb.name || lb.metadata?.name;
      return client.getLoadBalancer(namespace, name).catch(() => null);
    })
  )).filter(Boolean);

  progress?.(`Fetching referenced objects in ${namespace}...`);
  const referencedObjects = await fetchReferencedObjects(client, lbConfigs, namespace, policies, defaultPolicies);

  const baselineLbNames = new Set();
  for (const lb of lbConfigs) {
    const label = (lb.metadata?.labels || lb.labels || {})['xc-audit-baseline-lb'];
    if (label) baselineLbNames.add(label);
  }

  let baselineLbConfigs = {};
  let baselineLbReferencedObjects = { appFirewall: {}, servicePolicy: {} };
  if (baselineLbNames.size > 0) {
    await Promise.all([...baselineLbNames].map(async (name) => {
      try {
        const config = await client.getLoadBalancer('default', name);
        if (config) baselineLbConfigs[name] = config;
      } catch {}
    }));
    const blbArray = Object.values(baselineLbConfigs);
    if (blbArray.length > 0) {
      baselineLbReferencedObjects = await fetchReferencedObjects(client, blbArray, 'default', defaultPolicies, null);
    }
  }

  const effectiveBaseline = { ...baseline };
  if (defaultPolicies) {
    effectiveBaseline.namespace_baseline = defaultPolicies;
  }

  progress?.(`Running audit on ${lbConfigs.length} LBs in ${namespace}...`);

  const results = runFullAudit(lbConfigs, policies, effectiveBaseline, explanations, exemptionMap, referencedObjects);

  if (Object.keys(baselineLbConfigs).length > 0) {
    applyBaselineLbOverrides(results, lbConfigs, baselineLbConfigs, baselineLbReferencedObjects, effectiveBaseline, explanations, defaultPolicies);
  }

  function isActiveForPlan(checkPlan, checkKey) {
    return (planIncludes[plan]?.has(checkPlan)) || enabledAddons.has(checkKey);
  }

  if (checkCategories.length) {
    for (const lbResult of results.loadBalancers) {
      lbResult.categorized = groupByCategory(lbResult, checkCategories);
      lbResult.plan = plan;
      lbResult.addons = [...enabledAddons];

      const activeDiffs = lbResult.diffs.filter(d => {
        const topKey = d.path.split('.')[1];
        const check = checkCategories.flatMap(c => c.checks).find(c => c.key === topKey);
        return isActiveForPlan(check?.plan, check?.key) && check?.required !== false;
      });
      const activeInspections = (lbResult.inspections || []).filter(i => {
        const check = checkCategories.flatMap(c => c.checks).find(c => c.inspector === i.inspector);
        return isActiveForPlan(check?.plan, check?.key);
      });
      const hasNotInBaseline = (lbResult.baselineOverrides || []).some(o => o.overrideStatus === 'not_in_baseline');
      lbResult.pass = activeDiffs.length === 0 && activeInspections.every(i => i.pass) && !hasNotInBaseline;
    }
  }

  if (namespace !== 'default' && policies && defaultPolicies) {
    const policyComparison = { ...comparePolicies(policies, defaultPolicies), baselineSource: 'default namespace' };
    for (const lbResult of results.loadBalancers) {
      lbResult.policyComparison = policyComparison;
    }
  }

  return {
    name: namespace,
    managedTenant: tenantConfig.managedTenant || null,
    policies: results.policies,
    loadBalancers: results.loadBalancers.map(r => ({
      name: r.name,
      result: r,
    })),
  };
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function processQuotas(quotaData) {
  if (!quotaData) return [];
  const items = [];

  function collect(section, source) {
    if (!section) return;
    for (const [name, entry] of Object.entries(section)) {
      const max = entry.limit?.maximum;
      const current = entry.usage?.current;
      if (max == null || max <= 0 || current == null || current < 0) continue;
      const pct = Math.round((current / max) * 100);
      if (pct < 75) continue;
      const displayName = entry.display_name || name;
      items.push({
        name: displayName || name,
        current,
        maximum: max,
        pct,
        level: pct >= 90 ? 'warning' : 'notice',
        source,
        description: (entry.description || '').trim().split('\n')[0].trim(),
      });
    }
  }

  collect(quotaData.quota_usage, 'quota');
  collect(quotaData.float_quota_usage, 'resource');
  // objects and resources often duplicate quota_usage/float_quota_usage, skip to avoid dupes

  items.sort((a, b) => b.pct - a.pct);
  return items;
}

function buildQuotaHtml(quotaItems) {
  if (!quotaItems.length) return '';

  const warnings = quotaItems.filter(q => q.level === 'warning');
  const notices = quotaItems.filter(q => q.level === 'notice');

  let rows = '';
  for (const q of quotaItems) {
    const barColor = q.level === 'warning' ? '#dc3545' : '#fd7e14';
    const levelClass = q.level === 'warning' ? 'quota-warning' : 'quota-notice';
    rows += `<tr class="${levelClass}">
      <td>${escHtml(q.name)}</td>
      <td class="quota-num">${q.current}</td>
      <td class="quota-num">${q.maximum}</td>
      <td class="quota-num"><strong>${q.pct}%</strong></td>
      <td class="quota-bar-cell">
        <div class="quota-bar"><div class="quota-fill" style="width:${Math.min(q.pct, 100)}%;background:${barColor}"></div></div>
      </td>
    </tr>`;
  }

  return `<div class="quota-section">
<h3>Quota Usage</h3>
<p class="quota-desc">${warnings.length ? `<strong>${warnings.length}</strong> item${warnings.length !== 1 ? 's' : ''} at 90%+ (warning)` : ''}${warnings.length && notices.length ? ', ' : ''}${notices.length ? `<strong>${notices.length}</strong> item${notices.length !== 1 ? 's' : ''} at 75%+ (notice)` : ''}</p>
<table class="quota-table">
<thead><tr><th>Resource</th><th style="width:60px;text-align:right">Used</th><th style="width:60px;text-align:right">Limit</th><th style="width:50px;text-align:right">%</th><th style="width:120px"></th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
}

const QUOTA_CSS = `
.quota-section { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; padding: 16px; margin-bottom: 24px; }
.quota-section h3 { margin-bottom: 4px; font-size: 15px; }
.quota-desc { font-size: 12px; color: #666; margin-bottom: 10px; }
.quota-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.quota-table th, .quota-table td { padding: 6px 10px; border-bottom: 1px solid #dee2e6; text-align: left; }
.quota-table th { font-weight: 600; background: #f8f9fa; font-size: 12px; }
.quota-num { text-align: right !important; font-variant-numeric: tabular-nums; }
.quota-bar-cell { padding-right: 12px !important; }
.quota-bar { height: 8px; background: #e9ecef; border-radius: 4px; overflow: hidden; }
.quota-fill { height: 100%; border-radius: 4px; }
.quota-warning td { color: #721c24; }
.quota-notice td { color: #664d03; }
`;

export async function runFullReport(client, namespaces, tenantConfig, progress) {
  const tenantMeta = await fetchTenantMeta(client, tenantConfig.managedTenant);

  progress?.('Fetching quota usage...');
  const quotaData = await client.getQuotaUsage();
  const quotaItems = processQuotas(quotaData);
  if (quotaItems.length) {
    console.log(`[Quota] ${quotaItems.length} items at 75%+ usage`);
  }

  const nsResults = [];
  for (let i = 0; i < namespaces.length; i++) {
    const ns = namespaces[i];
    progress?.(`Auditing ${ns} (${i + 1} of ${namespaces.length})...`);
    try {
      const result = await auditNamespace(client, ns, tenantConfig, progress);
      console.log(`[Audit] ${ns}: ${result.loadBalancers.length} LBs, pass=${result.loadBalancers.filter(lb => lb.result.pass).length}`);
      nsResults.push(result);
    } catch (err) {
      console.error(`[Audit] ${ns} FAILED:`, err.stack);
      progress?.(`Error auditing ${ns}: ${err.message}`);
    }
  }

  const totalLbs = nsResults.reduce((sum, ns) => sum + ns.loadBalancers.length, 0);
  const warningLbs = nsResults.reduce((sum, ns) => sum + ns.loadBalancers.filter(lb => !lb.result.pass).length, 0);
  const passLbs = totalLbs - warningLbs;

  progress?.('Generating report...');
  console.log(`[Report] ${nsResults.length} namespaces, ${totalLbs} LBs`);

  let reportHtml;
  try {
    reportHtml = buildHtmlReport({
      tenant: tenantConfig.tenant,
      companyName: tenantMeta.companyName || tenantConfig.name || tenantConfig.tenant,
      logoDataUrl: tenantMeta.logoDataUrl,
      tenantChecks: tenantMeta.tenantChecks,
      namespaces: nsResults,
      checkCategories,
      plans: rawPlans,
      tierLabels: planMeta.tierLabels,
      owaspCategories,
      explanations: tenantConfig.explanations || defaultExplanations,
      generatedAt: new Date().toLocaleString(),
      version: 'webapp',
    });
  } catch (err) {
    console.error('[Report] buildHtmlReport failed:', err.stack);
    throw err;
  }

  // Inject quota section into report before the recommendations section
  if (quotaItems.length) {
    const quotaHtml = buildQuotaHtml(quotaItems);
    reportHtml = reportHtml.replace('</style>', QUOTA_CSS + '</style>');
    reportHtml = reportHtml.replace('<div class="recs-section">', quotaHtml + '\n<div class="recs-section">');
  }

  return {
    summary: {
      totalLbs,
      passing: passLbs,
      warnings: warningLbs,
      compliance: totalLbs > 0 ? Math.round((passLbs / totalLbs) * 100) : 100,
      namespaceCount: nsResults.length,
      quotaWarnings: quotaItems.filter(q => q.level === 'warning').length,
      quotaNotices: quotaItems.filter(q => q.level === 'notice').length,
    },
    quotaItems,
    namespaces: nsResults,
    reportHtml,
  };
}
