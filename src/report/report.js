import { buildHtmlReport } from '../lib/report-builder.js';

const $ = (id) => document.getElementById(id);

let selectedTenant = null;
let namespaceEntries = [];
let lastReportHtml = null;

function tenantKey(tenant, key) {
  return `tenant:${tenant}:${key}`;
}

async function getTenantConfig(tenant) {
  const keys = ['baseline', 'explanations', 'exemptionMap', 'settings'];
  if (!tenant) {
    const data = await chrome.storage.local.get(keys);
    return Object.fromEntries(keys.map((k) => [k, data[k]]));
  }
  const allKeys = [...keys.map((k) => tenantKey(tenant, k)), ...keys];
  const data = await chrome.storage.local.get(allKeys);
  const result = {};
  for (const k of keys) {
    result[k] = data[tenantKey(tenant, k)] ?? data[k];
  }
  return result;
}

function parseCacheKey(key, tenant) {
  if (!key.startsWith(tenant + '/')) return null;
  const rest = key.slice(tenant.length + 1);
  const parts = rest.split('/');
  if (parts.length === 1) return { namespace: parts[0], managedTenant: null };
  if (parts.length === 2) return { managedTenant: parts[0], namespace: parts[1] };
  return null;
}

document.addEventListener('DOMContentLoaded', async () => {
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  await initTenantSelector();
  await loadNamespaces();
  bindEvents();
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
    opt.textContent = t;
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
  namespaceEntries = [];

  if (!selectedTenant) {
    nsList.innerHTML = '<div class="empty-state">Select a tenant to see audited namespaces.</div>';
    $('nsCount').textContent = '';
    $('generate').disabled = true;
    return;
  }

  const { auditCache } = await chrome.storage.session.get('auditCache');
  if (!auditCache) {
    nsList.innerHTML = '<div class="empty-state">No audit data in this session. Visit namespace LB pages first.</div>';
    $('nsCount').textContent = '(0)';
    $('generate').disabled = true;
    return;
  }

  for (const [key, entry] of Object.entries(auditCache)) {
    const parsed = parseCacheKey(key, selectedTenant);
    if (!parsed) continue;

    const lbs = entry.loadBalancers || {};
    const lbCount = Object.keys(lbs).length;

    namespaceEntries.push({
      cacheKey: key,
      namespace: parsed.namespace,
      managedTenant: parsed.managedTenant,
      lbCount,
      policies: entry.policies || null,
      loadBalancers: Object.entries(lbs).map(([name, e]) => ({ name, result: e.result })),
    });
  }

  namespaceEntries.sort((a, b) => a.namespace.localeCompare(b.namespace));

  if (namespaceEntries.length === 0) {
    nsList.innerHTML = '<div class="empty-state">No audited namespaces for this tenant. Visit namespace LB pages first.</div>';
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
    cb.dataset.cacheKey = ns.cacheKey;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = ns.managedTenant ? `${ns.namespace} (${ns.managedTenant})` : ns.namespace;

    const meta = document.createElement('span');
    meta.className = 'ns-meta';
    meta.textContent = `${ns.lbCount} LB${ns.lbCount === 1 ? '' : 's'}`;

    item.appendChild(cb);
    item.appendChild(nameSpan);
    item.appendChild(meta);
    nsList.appendChild(item);
  }

  $('generate').disabled = false;
}

function getSelectedNamespaces() {
  const selected = new Set();
  for (const cb of $('nsList').querySelectorAll('input[type="checkbox"]')) {
    if (cb.checked) selected.add(cb.dataset.cacheKey);
  }
  return namespaceEntries.filter((ns) => selected.has(ns.cacheKey));
}

function bindEvents() {
  $('tenantSelect').addEventListener('change', async () => {
    selectedTenant = $('tenantSelect').value || null;
    await loadNamespaces();
    $('previewContainer').style.display = 'none';
    $('download').disabled = true;
    lastReportHtml = null;
  });

  $('selectAll').addEventListener('click', () => {
    for (const cb of $('nsList').querySelectorAll('input[type="checkbox"]')) cb.checked = true;
  });

  $('selectNone').addEventListener('click', () => {
    for (const cb of $('nsList').querySelectorAll('input[type="checkbox"]')) cb.checked = false;
  });

  $('generate').addEventListener('click', async () => {
    const selected = getSelectedNamespaces();
    if (selected.length === 0) return;

    $('generate').disabled = true;
    $('generate').textContent = 'Generating...';

    try {
      const metaKey = tenantKey(selectedTenant, 'meta');
      const [catResp, config, metaData] = await Promise.all([
        fetch(chrome.runtime.getURL('assets/check-categories.json')).then((r) => r.json()),
        getTenantConfig(selectedTenant),
        chrome.storage.local.get(metaKey),
      ]);
      const tenantMeta = metaData[metaKey] || {};

      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const timeStr = now.toLocaleString();

      lastReportHtml = buildHtmlReport({
        tenant: selectedTenant,
        companyName: tenantMeta.companyName || null,
        logoDataUrl: tenantMeta.logoDataUrl || null,
        namespaces: selected.map((ns) => ({
          name: ns.namespace,
          managedTenant: ns.managedTenant,
          policies: ns.policies,
          loadBalancers: ns.loadBalancers,
        })),
        checkCategories: catResp,
        explanations: config.explanations || {},
        generatedAt: timeStr,
        version: chrome.runtime.getManifest().version,
      });

      const preview = $('preview');
      preview.srcdoc = lastReportHtml;
      $('previewContainer').style.display = '';
      $('download').disabled = false;
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
    a.download = `xc-audit-${selectedTenant}-${dateStr}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}
