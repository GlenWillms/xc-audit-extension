import { runFullAudit, groupByCategory } from '../lib/audit-engine.js';

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
});

loadCategories();

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
    savePolicyOverride(message.namespace, message.policies).then(sendResponse);
    return true;
  }
  if (message.type === 'CLEAR_POLICY_OVERRIDE') {
    clearPolicyOverride(message.namespace).then(sendResponse);
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
  const { baseline, exemptionMap } = await chrome.storage.local.get(['baseline', 'exemptionMap']);
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

async function handleRunAudit({ tenant, namespace, managedTenant, policies, defaultPolicies, lbConfigs, lbVersions, referencedObjects }, forceRefresh) {
  const { baseline, explanations, exemptionMap, policyOverrides } =
    await chrome.storage.local.get(['baseline', 'explanations', 'exemptionMap', 'policyOverrides']);

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

  if (checkCategories.length) {
    const optionalKeys = new Set(
      checkCategories.flatMap((cat) => cat.checks.filter((c) => c.required === false).map((c) => c.key))
    );
    for (const lbResult of results.loadBalancers) {
      lbResult.categorized = groupByCategory(lbResult, checkCategories);
      const requiredDiffs = lbResult.diffs.filter((d) => !optionalKeys.has(d.path.split('.')[1]));
      const requiredInspections = (lbResult.inspections || []).filter((i) => !optionalKeys.has(i.categoryId));
      lbResult.pass = requiredDiffs.length === 0 && requiredInspections.every((i) => i.pass);
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

  auditCache[cacheKey] = {
    baselineHash: currentHash,
    policies: results.policies,
    loadBalancers: lbCache,
  };
  await chrome.storage.session.set({ auditCache });

  updateBadge(results);
  return { type: 'AUDIT_RESULTS', data: results };
}

async function savePolicyOverride(namespace, policies) {
  const { policyOverrides = {} } = await chrome.storage.local.get('policyOverrides');
  policyOverrides[namespace] = policies;
  await chrome.storage.local.set({ policyOverrides });
  return { ok: true };
}

async function clearPolicyOverride(namespace) {
  const { policyOverrides = {} } = await chrome.storage.local.get('policyOverrides');
  delete policyOverrides[namespace];
  await chrome.storage.local.set({ policyOverrides });
  return { ok: true };
}

function updateBadge(results) {
  const failCount = results.loadBalancers.filter((lb) => !lb.pass).length +
    (results.policies && !results.policies.pass ? 1 : 0);

  if (failCount > 0) {
    chrome.action.setBadgeText({ text: String(failCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#dc3545' });
  } else {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#28a745' });
  }
}
