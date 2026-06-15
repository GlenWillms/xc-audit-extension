import { buildHtmlReport } from '../lib/report-builder.js';

const $ = (id) => document.getElementById(id);
const XC_TAB_PATTERN = 'https://*.console.ves.volterra.io/*';

let selectedTenant = null;
let namespaceEntries = [];
let cachedKeys = new Set();
let lastReportHtml = null;

function parseCompositeId(id) {
  const parts = (id || '').split('::');
  return { tenant: parts[0], managedTenant: parts[1] || null };
}

function tenantKey(id, key) {
  return `tenant:${id}:${key}`;
}

async function getTenantConfig(id) {
  const keys = ['baseline', 'explanations', 'exemptionMap', 'settings'];
  if (!id) {
    const data = await chrome.storage.local.get(keys);
    return Object.fromEntries(keys.map((k) => [k, data[k]]));
  }
  const allKeys = [...keys.map((k) => tenantKey(id, k)), ...keys];
  const data = await chrome.storage.local.get(allKeys);
  const result = {};
  for (const k of keys) {
    result[k] = data[tenantKey(id, k)] ?? data[k];
  }
  return result;
}

function parseCacheKey(key, compositeId) {
  const { tenant, managedTenant } = parseCompositeId(compositeId);
  const prefix = managedTenant ? `${tenant}/${managedTenant}/` : `${tenant}/`;
  if (!key.startsWith(prefix)) return null;
  const namespace = key.slice(prefix.length);
  if (namespace.includes('/')) return null;
  return { namespace, managedTenant };
}

function buildCacheKey(compositeId, namespace) {
  const { tenant, managedTenant } = parseCompositeId(compositeId);
  return managedTenant ? `${tenant}/${managedTenant}/${namespace}` : `${tenant}/${namespace}`;
}

async function sendToXcTab(message) {
  const tabs = await chrome.tabs.query({ url: XC_TAB_PATTERN });
  if (!tabs.length) return { error: 'No XC console tab open. Open the XC console first.' };
  const { tenant: selParent } = parseCompositeId(selectedTenant);
  const match = tabs.find((t) => t.url?.includes(`${selParent}.console.ves.volterra.io`));
  if (!match) return { error: `No XC console tab open for ${selParent}. Open the correct tenant console first.` };
  const tabId = match.id;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/lib/url-parser.js', 'src/content/content-script.js'],
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['src/content/content-style.css'],
    });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  await initTenantSelector();
  bindEvents();
  await loadNamespaces();
});

async function initTenantSelector() {
  const { knownTenants = [], lastSelectedTenant } = await chrome.storage.local.get(['knownTenants', 'lastSelectedTenant']);
  const select = $('tenantSelect');
  select.innerHTML = '';

  if (!knownTenants.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No tenants found — navigate to XC console';
    select.appendChild(opt);
    selectedTenant = null;
    return;
  }

  for (const t of knownTenants) {
    const opt = document.createElement('option');
    opt.value = t;
    const { tenant, managedTenant } = parseCompositeId(t);
    opt.textContent = managedTenant ? `${tenant} > ${managedTenant}` : t;
    select.appendChild(opt);
  }

  if (lastSelectedTenant && knownTenants.includes(lastSelectedTenant)) {
    select.value = lastSelectedTenant;
    selectedTenant = lastSelectedTenant;
  } else {
    select.value = knownTenants[0];
    selectedTenant = knownTenants[0];
  }
}

async function loadNamespaces() {
  const nsList = $('nsList');
  const notice = $('notice');
  namespaceEntries = [];
  cachedKeys = new Set();

  if (!selectedTenant) {
    nsList.innerHTML = '<div class="empty-state">Select a tenant to see namespaces.</div>';
    $('nsCount').textContent = '';
    $('generate').disabled = true;
    notice.style.display = 'none';
    return;
  }

  const { auditCache } = await chrome.storage.session.get('auditCache');
  const cachedNamespaces = new Map();
  if (auditCache) {
    for (const [key, entry] of Object.entries(auditCache)) {
      const parsed = parseCacheKey(key, selectedTenant);
      if (!parsed) continue;
      cachedKeys.add(key);
      cachedNamespaces.set(parsed.namespace, {
        cacheKey: key,
        namespace: parsed.namespace,
        managedTenant: parsed.managedTenant,
        cached: true,
      });
    }
  }

  const { managedTenant: mt } = parseCompositeId(selectedTenant);
  let allNamespaces = null;
  let listResp = null;
  try {
    listResp = await sendToXcTab({ type: 'LIST_NAMESPACES', managedTenant: mt });
    if (listResp?.namespaces) allNamespaces = listResp.namespaces;
  } catch {
    listResp = { error: 'Could not reach the XC console tab.' };
  }

  if (allNamespaces) {
    for (const ns of allNamespaces) {
      if (!cachedNamespaces.has(ns)) {
        namespaceEntries.push({
          cacheKey: buildCacheKey(selectedTenant, ns),
          namespace: ns,
          managedTenant: mt,
          cached: false,
        });
      }
    }
    for (const entry of cachedNamespaces.values()) {
      namespaceEntries.push(entry);
    }
    notice.textContent = `Found ${allNamespaces.length} namespaces in tenant. ${cachedNamespaces.size} already audited.`;
    notice.style.display = '';
  } else {
    for (const entry of cachedNamespaces.values()) {
      namespaceEntries.push(entry);
    }
    if (listResp?.error) {
      notice.textContent = `Could not list namespaces: ${listResp.error}. Showing cached results only.`;
    } else {
      notice.textContent = 'No XC console tab open. Showing cached results only — open the XC console and reload to discover all namespaces.';
    }
    notice.style.display = '';
  }

  namespaceEntries.sort((a, b) => a.namespace.localeCompare(b.namespace));

  if (namespaceEntries.length === 0) {
    nsList.innerHTML = '<div class="empty-state">No namespaces found. Open the XC console and navigate to an LB list page first.</div>';
    $('nsCount').textContent = '(0)';
    $('generate').disabled = true;
    return;
  }

  $('nsCount').textContent = `(${namespaceEntries.length})`;
  nsList.innerHTML = '';

  for (const ns of namespaceEntries) {
    const item = document.createElement('label');
    item.className = 'ns-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.namespace = ns.namespace;
    cb.dataset.cacheKey = ns.cacheKey;
    cb.dataset.cached = ns.cached ? '1' : '0';
    cb.dataset.managedTenant = ns.managedTenant || '';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = ns.managedTenant ? `${ns.namespace} (${ns.managedTenant})` : ns.namespace;

    const status = document.createElement('span');
    status.className = `ns-status ${ns.cached ? 'ns-status-cached' : 'ns-status-pending'}`;
    status.textContent = ns.cached ? 'audited' : 'pending';

    item.appendChild(cb);
    item.appendChild(nameSpan);
    item.appendChild(status);
    nsList.appendChild(item);
  }

  $('generate').disabled = false;
}

function getSelectedEntries() {
  const entries = [];
  for (const cb of $('nsList').querySelectorAll('input[type="checkbox"]')) {
    if (cb.checked) {
      entries.push({
        namespace: cb.dataset.namespace,
        cacheKey: cb.dataset.cacheKey,
        cached: cb.dataset.cached === '1',
        managedTenant: cb.dataset.managedTenant || null,
      });
    }
  }
  return entries;
}

function showProgress(text, pct) {
  const el = $('progress');
  el.style.display = '';
  $('progressText').textContent = text;
  $('progressFill').style.width = `${Math.round(pct)}%`;
}

function hideProgress() {
  $('progress').style.display = 'none';
}

function bindEvents() {
  $('tenantSelect').addEventListener('change', async () => {
    selectedTenant = $('tenantSelect').value || null;
    await loadNamespaces();
    $('previewContainer').style.display = 'none';
    $('download').disabled = true;
    lastReportHtml = null;
    hideProgress();
  });

  $('selectAll').addEventListener('click', () => {
    for (const cb of $('nsList').querySelectorAll('input[type="checkbox"]')) cb.checked = true;
  });

  $('selectNone').addEventListener('click', () => {
    for (const cb of $('nsList').querySelectorAll('input[type="checkbox"]')) cb.checked = false;
  });

  $('generate').addEventListener('click', async () => {
    const selected = getSelectedEntries();
    if (selected.length === 0) return;

    const needsAudit = selected.filter((e) => !e.cached);
    const alreadyAudited = selected.filter((e) => e.cached);

    if (needsAudit.length > 0) {
      const totalSelected = selected.length;
      if (totalSelected > 25 || (alreadyAudited.length > 0 && totalSelected > 2 * alreadyAudited.length)) {
        const ok = confirm(
          `This will audit ${needsAudit.length} namespace${needsAudit.length === 1 ? '' : 's'} (${totalSelected} total selected). This may take a while. Continue?`
        );
        if (!ok) return;
      }
    }

    $('generate').disabled = true;
    $('download').disabled = true;

    try {
      if (needsAudit.length > 0) {
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < needsAudit.length; i++) {
          const ns = needsAudit[i];
          showProgress(`Auditing ${ns.namespace} (${i + 1} of ${needsAudit.length})...`, ((i) / needsAudit.length) * 100);
          try {
            await sendToXcTab({ type: 'AUDIT_NAMESPACE', namespace: ns.namespace, managedTenant: ns.managedTenant });
          } catch {}
          if (i < needsAudit.length - 1) await delay(200);
        }
        showProgress('Building report...', 100);
      } else {
        showProgress('Building report...', 100);
      }

      const { auditCache } = await chrome.storage.session.get('auditCache');
      const metaKey = tenantKey(selectedTenant, 'meta');
      const [catResp, config, metaData] = await Promise.all([
        fetch(chrome.runtime.getURL('assets/check-categories.json')).then((r) => r.json()),
        getTenantConfig(selectedTenant),
        chrome.storage.local.get(metaKey),
      ]);
      const tenantMeta = metaData[metaKey] || {};

      const reportNamespaces = [];
      for (const entry of selected) {
        const cacheKey = buildCacheKey(selectedTenant, entry.namespace);
        const cached = auditCache?.[cacheKey];
        if (!cached) continue;
        const lbs = cached.loadBalancers || {};
        reportNamespaces.push({
          name: entry.namespace,
          managedTenant: entry.managedTenant,
          policies: cached.policies || null,
          loadBalancers: Object.entries(lbs).map(([name, e]) => ({ name, result: e.result })),
        });
      }

      if (reportNamespaces.length === 0) {
        hideProgress();
        $('generate').disabled = false;
        $('generate').textContent = 'Generate Report';
        alert('No audit data available. Ensure an XC console tab is open and try again.');
        return;
      }

      const timeStr = new Date().toLocaleString();
      const { tenant: rawTenant, managedTenant: selectedMt } = parseCompositeId(selectedTenant);
      lastReportHtml = buildHtmlReport({
        tenant: selectedMt || rawTenant,
        companyName: selectedMt || tenantMeta.companyName || null,
        logoDataUrl: tenantMeta.logoDataUrl || null,
        tenantChecks: tenantMeta.tenantChecks || null,
        namespaces: reportNamespaces,
        checkCategories: catResp.categories || catResp,
        plans: catResp.plans || {},
        tierLabels: catResp.tierLabels || {},
        owaspCategories: catResp.owaspCategories || null,
        explanations: config.explanations || {},
        generatedAt: timeStr,
        version: chrome.runtime.getManifest().version,
      });

      $('preview').srcdoc = lastReportHtml;
      $('previewContainer').style.display = '';
      $('download').disabled = false;
      hideProgress();
    } finally {
      $('generate').disabled = false;
      $('generate').textContent = 'Generate Report';
    }
  });

  $('download').addEventListener('click', () => {
    if (!lastReportHtml) return;

    const blob = new Blob([lastReportHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().split('T')[0];
    a.href = url;
    const { tenant: dlTenant, managedTenant: dlMt } = parseCompositeId(selectedTenant);
    const dlName = dlMt ? `${dlTenant}-${dlMt}` : dlTenant;
    a.download = `xc-audit-${dlName}-${dateStr}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}
