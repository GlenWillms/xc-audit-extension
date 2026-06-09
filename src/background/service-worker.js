import { runFullAudit } from '../lib/audit-engine.js';

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

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;

  const [baselineResp, explanationsResp] = await Promise.all([
    fetch(chrome.runtime.getURL('assets/baseline_lb_http.json')),
    fetch(chrome.runtime.getURL('assets/explanations.json')),
  ]);
  const baseline = await baselineResp.json();
  const explanations = await explanationsResp.json();

  await chrome.storage.local.set({
    baseline,
    explanations,
    settings: { autoAudit: true, cacheTtlSeconds: 300 },
  });
});

// --- API fetching (runs in background with session cookies) ---

async function fetchApiData(tabId, tenant, namespace) {
  const td = tabData[tabId];
  const csrf = td?.csrf;
  if (!csrf) throw new Error('NO_CSRF');

  const base = `https://${tenant}.console.ves.volterra.io`;
  const prefix = td.managedTenant ? `/managed_tenant/${td.managedTenant}` : '';

  console.log('[xc-audit] fetchApiData:', { tenant, namespace, managedTenant: td.managedTenant || 'none' });

  function apiUrl(path) {
    return `${base}${prefix}${path}?report_fields&csrf=${csrf}`;
  }

  const cookies = await chrome.cookies.getAll({ domain: '.console.ves.volterra.io' });
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  const opts = {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      'X-CSRF-Token': csrf,
      'Cookie': cookieHeader,
    },
  };

  const [policyResp, lbListResp] = await Promise.all([
    fetch(apiUrl(`/api/config/namespaces/${namespace}/active_service_policies`), opts)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(apiUrl(`/api/config/namespaces/${namespace}/http_loadbalancers`), opts),
  ]);

  if (!lbListResp.ok) throw new Error(`API ${lbListResp.status}`);
  const lbListBody = await lbListResp.json();
  console.log('[xc-audit] LB list response keys:', Object.keys(lbListBody));
  console.log('[xc-audit] LB list items count:', lbListBody.items?.length ?? 'no items key');
  console.log('[xc-audit] LB list body preview:', JSON.stringify(lbListBody).slice(0, 500));
  const lbList = lbListBody.items || [];

  const lbConfigs = (
    await Promise.all(
      lbList.map((lb) => {
        console.log('[xc-audit] Fetching individual LB:', lb.name);
        return fetch(apiUrl(`/api/config/namespaces/${namespace}/http_loadbalancers/${lb.name}`), opts)
          .then((r) => {
            console.log('[xc-audit] LB detail response:', lb.name, r.status);
            return r.ok ? r.json() : null;
          })
          .catch((err) => {
            console.error('[xc-audit] LB detail fetch error:', lb.name, err.message);
            return null;
          });
      })
    )
  ).filter(Boolean);

  console.log('[xc-audit] Total LB configs fetched:', lbConfigs.length);
  return { policies: policyResp, lbConfigs };
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

async function handleFetchAndAudit({ tenant, namespace }, sender, forceRefresh) {
  let tabId = sender.tab?.id;
  if (!tabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = activeTab?.id;
  }
  if (!tabId) return { type: 'AUDIT_ERROR', error: 'NO_TAB' };

  const { baseline, explanations, settings } =
    await chrome.storage.local.get(['baseline', 'explanations', 'settings']);

  if (!baseline) {
    return { type: 'AUDIT_ERROR', error: 'INVALID_BASELINE', message: 'No baseline configured.' };
  }

  const cacheKey = `${tenant}/${namespace}`;
  const ttl = (settings?.cacheTtlSeconds || 300) * 1000;

  if (!forceRefresh) {
    const { auditCache } = await chrome.storage.session.get('auditCache');
    const cached = auditCache?.[cacheKey];
    if (cached && Date.now() - cached.timestamp < ttl) {
      updateBadge(cached.results);
      return { type: 'AUDIT_RESULTS', data: cached.results };
    }
  }

  try {
    const { policies, lbConfigs } = await fetchApiData(tabId, tenant, namespace);

    const results = runFullAudit(lbConfigs, policies, baseline, explanations || {});

    const cache = auditCache || {};
    cache[cacheKey] = { timestamp: Date.now(), results };
    await chrome.storage.session.set({ auditCache: cache });

    updateBadge(results);
    return { type: 'AUDIT_RESULTS', data: results };
  } catch (err) {
    return { type: 'AUDIT_ERROR', error: err.message };
  }
}

async function handleRunAudit({ tenant, namespace, policies, lbConfigs }, forceRefresh) {
  const { baseline, explanations, settings } =
    await chrome.storage.local.get(['baseline', 'explanations', 'settings']);

  if (!baseline) {
    return { type: 'AUDIT_ERROR', error: 'INVALID_BASELINE', message: 'No baseline configured.' };
  }

  const cacheKey = `${tenant}/${namespace}`;
  const ttl = (settings?.cacheTtlSeconds || 300) * 1000;

  if (!forceRefresh) {
    const { auditCache } = await chrome.storage.session.get('auditCache');
    const cached = auditCache?.[cacheKey];
    if (cached && Date.now() - cached.timestamp < ttl) {
      updateBadge(cached.results);
      return { type: 'AUDIT_RESULTS', data: cached.results };
    }
  }

  const results = runFullAudit(
    lbConfigs || [],
    policies,
    baseline,
    explanations || {}
  );

  const { auditCache = {} } = await chrome.storage.session.get('auditCache');
  auditCache[cacheKey] = { timestamp: Date.now(), results };
  await chrome.storage.session.set({ auditCache });

  updateBadge(results);
  return { type: 'AUDIT_RESULTS', data: results };
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
