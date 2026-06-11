import { runFullAudit, groupByCategory, comparePolicies, applyBaselineLbOverrides } from '../lib/audit-engine.js';

const tabData = {};

function ensureTab(tabId) {
  if (!tabData[tabId]) tabData[tabId] = { csrf: null, managedTenant: null };
  return tabData[tabId];
}

// --- CSRF + managed tenant capture via webRequest ---

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!details.tabId || details.tabId === -1) return;
    if (!details.url.includes('console.ves.volterra.io')) return;

    const td = ensureTab(details.tabId);

    const managedMatch = details.url.match(/\/managed_tenant\/([^/]+)/);
    if (managedMatch) td.managedTenant = managedMatch[1];

    try {
      const url = new URL(details.url);
      const csrf = url.searchParams.get('csrf');
      if (csrf) td.csrf = csrf;
    } catch {}
  },
  { urls: ['https://*.console.ves.volterra.io/*'] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details.tabId || details.tabId === -1) return;
    const td = ensureTab(details.tabId);
    if (td.csrf) return;

    for (const header of details.requestHeaders || []) {
      if (header.name.toLowerCase() === 'x-csrf-token' && header.value) {
        td.csrf = header.value;
        return;
      }
    }
  },
  { urls: ['https://*.console.ves.volterra.io/*'] },
  ['requestHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabData[tabId];
});

// --- Extension lifecycle ---

chrome.commands.onCommand.addListener((command) => {
  if (command === 'reload-extension') chrome.runtime.reload();
});

let checkCategories = [];

async function loadCategories() {
  const resp = await fetch(chrome.runtime.getURL('assets/check-categories.json'));
  checkCategories = await resp.json();
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadCategories();

  const existing = await chrome.storage.local.get(['baseline', 'explanations', 'exemptionMap', 'settings']);

  const [baselineResp, explanationsResp, exemptionResp] = await Promise.all([
    fetch(chrome.runtime.getURL('assets/baseline_lb_http.json')),
    fetch(chrome.runtime.getURL('assets/explanations.json')),
    fetch(chrome.runtime.getURL('assets/exemption_map.json')),
  ]);

  const defaults = {
    baseline: await baselineResp.json(),
    explanations: await explanationsResp.json(),
    exemptionMap: await exemptionResp.json(),
  };

  const toSet = {};
  if (!existing.baseline) {
    toSet.baseline = defaults.baseline;
  } else {
    const merged = { ...existing.baseline };
    const defaultInspectors = defaults.baseline.inspector_baselines || {};
    const existingInspectors = merged.inspector_baselines || {};
    let changed = false;
    for (const [key, val] of Object.entries(defaultInspectors)) {
      if (!(key in existingInspectors)) {
        existingInspectors[key] = val;
        changed = true;
      }
    }
    if (changed) {
      merged.inspector_baselines = existingInspectors;
      toSet.baseline = merged;
    }
  }
  if (!existing.explanations) toSet.explanations = defaults.explanations;
  if (!existing.exemptionMap) toSet.exemptionMap = defaults.exemptionMap;
  if (!existing.settings) toSet.settings = { autoAudit: true };

  if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);

  const { knownTenants = [] } = await chrome.storage.local.get('knownTenants');
  const tenantUpdates = {};
  for (const t of knownTenants) {
    const key = tenantKey(t, 'baseline');
    const data = await chrome.storage.local.get(key);
    const tenantBaseline = data[key];
    if (tenantBaseline) {
      const tenantInspectors = tenantBaseline.inspector_baselines || {};
      let changed = false;
      for (const [k, v] of Object.entries(defaults.baseline.inspector_baselines || {})) {
        if (!(k in tenantInspectors)) {
          tenantInspectors[k] = v;
          changed = true;
        }
      }
      if (changed) {
        tenantBaseline.inspector_baselines = tenantInspectors;
        tenantUpdates[key] = tenantBaseline;
      }
    }
  }
  if (Object.keys(tenantUpdates).length) await chrome.storage.local.set(tenantUpdates);
});

loadCategories();

// --- Tenant-scoped storage ---

function tenantKey(tenant, key) {
  return `tenant:${tenant}:${key}`;
}

async function getTenantConfig(tenant) {
  const keys = ['baseline', 'explanations', 'exemptionMap', 'settings', 'policyOverrides'];
  const allKeys = [...keys.map((k) => tenantKey(tenant, k)), ...keys];
  const data = await chrome.storage.local.get(allKeys);
  const result = {};
  for (const k of keys) {
    result[k] = data[tenantKey(tenant, k)] ?? data[k];
  }
  return result;
}

async function trackTenant(tenant) {
  const { knownTenants = [] } = await chrome.storage.local.get('knownTenants');
  if (!knownTenants.includes(tenant)) {
    await chrome.storage.local.set({ knownTenants: [...knownTenants, tenant] });
  }
}

// --- Hashing for version-based cache ---

async function hashJson(obj) {
  const text = JSON.stringify(obj);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CSRF') {
    const tabId = sender.tab?.id;
    let csrf = tabData[tabId]?.csrf || null;
    if (!csrf) {
      for (const td of Object.values(tabData)) {
        if (td.csrf) { csrf = td.csrf; break; }
      }
    }
    sendResponse({ csrf });
    return;
  }
  if (message.type === 'CLEAR_CACHE') {
    chrome.storage.session.remove('auditCache').then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'SAVE_POLICY_OVERRIDE') {
    savePolicyOverride(message.tenant, message.namespace, message.policies).then(sendResponse);
    return true;
  }
  if (message.type === 'CLEAR_POLICY_OVERRIDE') {
    clearPolicyOverride(message.tenant, message.namespace).then(sendResponse);
    return true;
  }
  if (message.type === 'CHECK_VERSIONS') {
    handleCheckVersions(message).then(sendResponse);
    return true;
  }
  if (message.type === 'RUN_AUDIT') {
    handleRunAudit(message, false).then(sendResponse);
    return true;
  }
  if (message.type === 'FORCE_RUN_AUDIT') {
    handleRunAudit(message, true).then(sendResponse);
    return true;
  }
  if (message.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
  }
});

function buildCacheKey(tenant, namespace, managedTenant) {
  return managedTenant ? `${tenant}/${managedTenant}/${namespace}` : `${tenant}/${namespace}`;
}

async function handleCheckVersions({ tenant, namespace, managedTenant, lbVersions }) {
  const { baseline, exemptionMap } = await getTenantConfig(tenant);
  const currentHash = await hashJson({ baseline, exemptionMap });

  const cacheKey = buildCacheKey(tenant, namespace, managedTenant);
  const { auditCache } = await chrome.storage.session.get('auditCache');
  const cached = auditCache?.[cacheKey];

  const stale = [];
  const fresh = {};

  if (!cached || cached.baselineHash !== currentHash) {
    return { stale: lbVersions.map((lb) => lb.name), fresh: {} };
  }

  for (const lb of lbVersions) {
    const cachedLb = cached.loadBalancers?.[lb.name];
    if (cachedLb && cachedLb.version === lb.version) {
      fresh[lb.name] = cachedLb.result;
    } else {
      stale.push(lb.name);
    }
  }

  return { stale, fresh };
}

async function handleRunAudit({ tenant, namespace, managedTenant, policies, defaultPolicies, lbConfigs, lbVersions, referencedObjects, baselineLbConfigs, baselineLbReferencedObjects }, forceRefresh) {
  await trackTenant(tenant);
  const { baseline, explanations, exemptionMap, policyOverrides, settings } = await getTenantConfig(tenant);

  if (!baseline) {
    return { type: 'AUDIT_ERROR', error: 'INVALID_BASELINE', message: 'No baseline configured.' };
  }

  const effectiveBaseline = { ...baseline };
  const nsOverride = policyOverrides?.[namespace];
  if (nsOverride) {
    effectiveBaseline.namespace_baseline = nsOverride;
  } else if (defaultPolicies) {
    effectiveBaseline.namespace_baseline = defaultPolicies;
  }

  const results = runFullAudit(
    lbConfigs || [],
    policies,
    effectiveBaseline,
    explanations || {},
    exemptionMap || {},
    referencedObjects || {}
  );

  if (baselineLbConfigs && Object.keys(baselineLbConfigs).length > 0) {
    applyBaselineLbOverrides(
      results, lbConfigs || [], baselineLbConfigs,
      baselineLbReferencedObjects || {},
      effectiveBaseline, explanations || {}, defaultPolicies
    );
  }

  if (checkCategories.length) {
    const plan = settings?.plan || 'essentials';
    const enabledAddons = new Set(settings?.addons || []);

    function isActiveForPlan(checkPlan, checkKey) {
      if (checkPlan === 'essentials') return true;
      if (checkPlan === 'enterprise') return plan === 'enterprise';
      if (checkPlan === 'addon') return plan === 'enterprise' || enabledAddons.has(checkKey);
      return false;
    }

    for (const lbResult of results.loadBalancers) {
      lbResult.categorized = groupByCategory(lbResult, checkCategories);
      lbResult.plan = plan;
      lbResult.addons = [...enabledAddons];

      const activeDiffs = lbResult.diffs.filter((d) => {
        const topKey = d.path.split('.')[1];
        const check = checkCategories.flatMap((c) => c.checks).find((c) => c.key === topKey);
        return isActiveForPlan(check?.plan, check?.key) && check?.required !== false;
      });
      const activeInspections = (lbResult.inspections || []).filter((i) => {
        const check = checkCategories.flatMap((c) => c.checks).find((c) => c.inspector === i.inspector);
        return isActiveForPlan(check?.plan, check?.key);
      });
      lbResult.pass = activeDiffs.length === 0 && activeInspections.every((i) => i.pass);
    }
  }

  const currentHash = await hashJson({ baseline, exemptionMap });
  const cacheKey = buildCacheKey(tenant, namespace, managedTenant);
  const { auditCache = {} } = await chrome.storage.session.get('auditCache');

  const existing = auditCache[cacheKey] || {};
  const lbCache = existing.loadBalancers || {};

  const versions = lbVersions || [];
  for (const lbResult of results.loadBalancers) {
    const ver = versions.find((v) => v.name === lbResult.name);
    lbCache[lbResult.name] = {
      version: ver?.version || null,
      result: lbResult,
    };
  }

  const baselinePolicies = nsOverride || defaultPolicies;
  if ((settings?.comparePolicyToDefault !== false) && namespace !== 'default' && policies && baselinePolicies) {
    const baselineSource = nsOverride ? 'saved baseline' : 'default namespace';
    const policyComparison = { ...comparePolicies(policies, baselinePolicies), baselineSource };
    for (const lbResult of results.loadBalancers) {
      lbResult.policyComparison = policyComparison;
    }
  }

  auditCache[cacheKey] = {
    baselineHash: currentHash,
    policies: results.policies,
    loadBalancers: lbCache,
  };
  await chrome.storage.session.set({ auditCache });

  updateBadge(results);
  return { type: 'AUDIT_RESULTS', data: results };
}

async function savePolicyOverride(tenant, namespace, policies) {
  const key = tenant ? tenantKey(tenant, 'policyOverrides') : 'policyOverrides';
  const data = await chrome.storage.local.get(key);
  const overrides = data[key] || {};
  overrides[namespace] = policies;
  await chrome.storage.local.set({ [key]: overrides });
  return { ok: true };
}

async function clearPolicyOverride(tenant, namespace) {
  const key = tenant ? tenantKey(tenant, 'policyOverrides') : 'policyOverrides';
  const data = await chrome.storage.local.get(key);
  const overrides = data[key] || {};
  delete overrides[namespace];
  await chrome.storage.local.set({ [key]: overrides });
  return { ok: true };
}

function updateBadge(results) {
  const warningCount = results.loadBalancers.filter((lb) => !lb.pass).length +
    (results.policies && !results.policies.pass ? 1 : 0);

  if (warningCount > 0) {
    chrome.action.setBadgeText({ text: String(warningCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#dc3545' });
  } else {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#28a745' });
  }
}
