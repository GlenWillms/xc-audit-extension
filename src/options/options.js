const $ = (id) => document.getElementById(id);

const XC_TAB_PATTERN = 'https://*.console.ves.volterra.io/*';

let selectedTenant = null;

function parseCompositeId(id) {
  const parts = (id || '').split('::');
  return { tenant: parts[0], managedTenant: parts[1] || null };
}

function shortTenantName(id) {
  if (!id) return '';
  const { tenant, managedTenant } = parseCompositeId(id);
  if (managedTenant) return managedTenant;
  const parts = tenant.split('-');
  return parts.length > 1 ? parts.slice(0, -1).join('-') : tenant;
}

function tenantKey(tenant, key) {
  return `tenant:${tenant}:${key}`;
}

async function getTenantConfig(tenant) {
  const keys = ['baseline', 'explanations', 'exemptionMap', 'settings', 'policyOverrides'];
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

async function setTenantData(key, value) {
  const storageKey = selectedTenant ? tenantKey(selectedTenant, key) : key;
  await chrome.storage.local.set({ [storageKey]: value });
}

async function removeTenantData(key) {
  const storageKey = selectedTenant ? tenantKey(selectedTenant, key) : key;
  await chrome.storage.local.remove(storageKey);
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

let CHECK_CATEGORIES = [];
let CHECK_REGISTRY = [];
let ADDON_TIERS = [];
let PLAN_INCLUDES = {};

async function loadCategories() {
  const resp = await fetch(chrome.runtime.getURL('assets/check-categories.json'));
  const data = await resp.json();
  CHECK_CATEGORIES = data.categories || [];
  ADDON_TIERS = data.addonTiers || [];
  PLAN_INCLUDES = {};
  for (const [id, def] of Object.entries(data.plans || {})) {
    PLAN_INCLUDES[id] = def.includes || [];
  }
  CHECK_REGISTRY = CHECK_CATEGORIES.flatMap((cat) =>
    cat.checks.map((check) => ({ ...check, category: cat.label, categoryId: cat.id }))
  );
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadCategories();
  await initTenantSelector();
  await loadTenantConfig();
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

async function loadTenantConfig() {
  const config = await getTenantConfig(selectedTenant);
  const { settings: globalSettings } = await chrome.storage.local.get('settings');

  renderChecks(config.baseline);
  renderPolicies();
  renderExemptionMap(config.exemptionMap || {});
  renderRawJson(config.baseline, config.explanations);
  const tenantLabel = selectedTenant ? shortTenantName(selectedTenant) : 'XC';
  $('registerLabels').textContent = `Register Labels in ${tenantLabel}`;
  $('deleteLabels').textContent = `Delete Labels from ${tenantLabel}`;

  const s = config.settings || {};
  $('autoAudit').checked = (globalSettings || {}).autoAudit !== false;
  $('comparePolicyToDefault').checked = s.comparePolicyToDefault !== false;
  $('planSelect').value = s.plan || 'essentials';
  renderAddons(s);
}

function renderAddons(settings) {
  const container = $('addonsContainer');
  container.innerHTML = '';
  const plan = settings.plan || 'essentials';

  const included = new Set(PLAN_INCLUDES[plan] || ['essentials']);

  const addons = CHECK_CATEGORIES.flatMap((cat) =>
    cat.checks.filter((c) => ADDON_TIERS.includes(c.plan)).map((c) => ({ ...c, category: cat.label }))
  );
  const enabledAddons = settings.addons || [];
  for (const addon of addons) {
    const includedInPlan = included.has(addon.plan);
    const row = document.createElement('label');
    row.className = 'toggle-row';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = includedInPlan || enabledAddons.includes(addon.key);
    toggle.disabled = includedInPlan;
    toggle.dataset.addonKey = addon.key;
    const span = document.createElement('span');
    span.textContent = addon.label + (includedInPlan ? ' (included)' : '');
    row.appendChild(toggle);
    row.appendChild(span);
    container.appendChild(row);
  }
}

function renderChecks(baseline) {
  const spec = baseline?.lb_baseline?.spec || {};
  $('wafPolicyName').value = spec.app_firewall?.name || '';
  const container = $('checksContainer');
  container.innerHTML = '';

  for (const cat of CHECK_CATEGORIES) {
    const group = document.createElement('div');
    group.className = 'check-group';

    const header = document.createElement('div');
    header.className = 'check-group-header';
    header.textContent = cat.label;
    group.appendChild(header);

    for (const check of cat.checks) {
      const row = document.createElement('label');
      row.className = 'check-row';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = check.key in spec;
      toggle.dataset.key = check.key;

      const info = document.createElement('div');
      info.className = 'check-info';
      info.innerHTML = `<span class="check-label">${check.label}</span>` +
        `<span class="check-code">Label: <code>xc-audit-${check.code}=true</code></span>`;

      row.appendChild(toggle);
      row.appendChild(info);
      group.appendChild(row);
    }

    container.appendChild(group);
  }
}

async function renderPolicies() {
  const container = $('currentPolicies');
  const config = await getTenantConfig(selectedTenant);
  const staticPolicies = config.baseline?.namespace_baseline?.service_policies;

  if (staticPolicies && Array.isArray(staticPolicies) && staticPolicies.length) {
    container.innerHTML = `<div class="policy-source">Static fallback baseline:</div>` +
      staticPolicies.map((p) =>
        `<div class="policy-item">${p.name} <span class="policy-ns">(${p.namespace})</span></div>`
      ).join('');
  } else {
    container.innerHTML = `<div class="policy-source">Policy baseline is fetched dynamically from the <code>default</code> namespace at audit time.</div>`;
  }

  const overrides = config.policyOverrides || {};
  const overridesList = $('overridesList');
  overridesList.innerHTML = '';
  const nsNames = Object.keys(overrides);
  if (nsNames.length === 0) {
    overridesList.innerHTML = '<div class="policy-source">No namespace overrides set.</div>';
  } else {
    for (const ns of nsNames) {
      const row = document.createElement('div');
      row.className = 'override-row';
      const policies = overrides[ns]?.service_policies || [];
      row.innerHTML = `<strong>${ns}</strong>: ${policies.map((p) => p.name).join(', ') || '(empty)'}` +
        ` <button class="btn-danger btn-sm override-remove" data-ns="${ns}">Remove</button>`;
      row.querySelector('.override-remove').addEventListener('click', async () => {
        delete overrides[ns];
        await setTenantData('policyOverrides', overrides);
        renderPolicies();
        showStatus('policiesStatus', `Override for ${ns} removed`, 'success');
      });
      overridesList.appendChild(row);
    }
  }
}

function renderExemptionMap(map) {
  const container = $('exemptionContainer');
  container.innerHTML = '';

  for (const [code, entry] of Object.entries(map)) {
    const row = document.createElement('div');
    row.className = 'exemption-row';
    row.innerHTML =
      `<input type="text" class="ex-code" value="${code}" placeholder="code">` +
      `<input type="text" class="ex-label" value="${entry.label || ''}" placeholder="Label">` +
      `<input type="text" class="ex-keys" value="${(entry.keys || []).join(', ')}" placeholder="Baseline keys (comma-separated)">` +
      `<button class="btn-danger btn-sm ex-remove">x</button>`;
    row.querySelector('.ex-remove').addEventListener('click', () => row.remove());
    container.appendChild(row);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-secondary btn-sm';
  addBtn.textContent = '+ Add Exemption';
  addBtn.addEventListener('click', () => {
    const row = document.createElement('div');
    row.className = 'exemption-row';
    row.innerHTML =
      `<input type="text" class="ex-code" placeholder="code">` +
      `<input type="text" class="ex-label" placeholder="Label">` +
      `<input type="text" class="ex-keys" placeholder="Baseline keys (comma-separated)">` +
      `<button class="btn-danger btn-sm ex-remove">x</button>`;
    row.querySelector('.ex-remove').addEventListener('click', () => row.remove());
    container.insertBefore(row, addBtn);
  });
  container.appendChild(addBtn);
}

function renderRawJson(baseline, explanations) {
  if (baseline) $('baselineEditor').value = JSON.stringify(baseline, null, 2);
  if (explanations) $('explanationsEditor').value = JSON.stringify(explanations, null, 2);
}

async function collectChecksToBaseline() {
  const config = await getTenantConfig(selectedTenant);
  const b = config.baseline || {};
  if (!b.lb_baseline) b.lb_baseline = {};
  const origSpec = b.lb_baseline.spec || {};
  const newSpec = {};

  const allKeys = new Set(CHECK_REGISTRY.map((c) => c.key));
  for (const [k, v] of Object.entries(origSpec)) {
    if (!allKeys.has(k)) newSpec[k] = v;
  }

  const toggles = $('checksContainer').querySelectorAll('input[type="checkbox"]');
  for (const t of toggles) {
    if (t.checked) {
      newSpec[t.dataset.key] = origSpec[t.dataset.key] ?? {};
    }
  }

  const wafName = $('wafPolicyName').value.trim();
  if ('app_firewall' in newSpec) {
    newSpec.app_firewall = wafName ? { name: wafName } : {};
  }

  b.lb_baseline.spec = newSpec;
  return b;
}

function collectExemptionMap() {
  const map = {};
  const rows = $('exemptionContainer').querySelectorAll('.exemption-row');
  for (const row of rows) {
    const code = row.querySelector('.ex-code')?.value.trim();
    const label = row.querySelector('.ex-label')?.value.trim();
    const keysStr = row.querySelector('.ex-keys')?.value.trim();
    if (!code) continue;
    map[code] = {
      label: label || code,
      keys: keysStr.split(',').map((k) => k.trim()).filter(Boolean),
    };
  }
  return map;
}

async function resetAllToDefaults() {
  if (selectedTenant) {
    const keys = ['baseline', 'explanations', 'exemptionMap', 'settings', 'policyOverrides'];
    await chrome.storage.local.remove(keys.map((k) => tenantKey(selectedTenant, k)));
  } else {
    const [baselineResp, explanationsResp, exemptionResp] = await Promise.all([
      fetch(chrome.runtime.getURL('assets/baseline_lb_http.json')),
      fetch(chrome.runtime.getURL('assets/explanations.json')),
      fetch(chrome.runtime.getURL('assets/exemption_map.json')),
    ]);
    await chrome.storage.local.set({
      baseline: await baselineResp.json(),
      explanations: await explanationsResp.json(),
      exemptionMap: await exemptionResp.json(),
    });
  }

  await loadTenantConfig();
}

function bindEvents() {
  $('tenantSelect').addEventListener('change', async () => {
    selectedTenant = $('tenantSelect').value || null;
    await chrome.storage.local.set({ lastSelectedTenant: selectedTenant });
    await loadTenantConfig();
  });

  $('resetAll').addEventListener('click', async () => {
    const target = selectedTenant || 'global defaults';
    if (!confirm(`Reset all settings for ${target} to defaults? This will clear any customizations and namespace policy overrides.`)) return;
    await resetAllToDefaults();
    showStatus('resetAllStatus', 'All settings reset to defaults', 'success');
  });

  $('saveChecks').addEventListener('click', async () => {
    const baseline = await collectChecksToBaseline();
    await setTenantData('baseline', baseline);
    renderRawJson(baseline, null);
    showStatus('checksStatus', 'Saved', 'success');
  });

  $('resetChecks').addEventListener('click', async () => {
    if (selectedTenant) {
      await removeTenantData('baseline');
    } else {
      const resp = await fetch(chrome.runtime.getURL('assets/baseline_lb_http.json'));
      await chrome.storage.local.set({ baseline: await resp.json() });
    }
    await loadTenantConfig();
    showStatus('checksStatus', 'Reset to defaults', 'success');
  });

  $('fetchDefaultPolicies').addEventListener('click', async () => {
    showStatus('policiesStatus', 'Fetching...', 'success');
    try {
      const resp = await sendToXcTab({ type: 'GET_POLICIES', namespace: 'default' });

      if (resp?.error) {
        showStatus('policiesStatus', resp.error, 'error');
        return;
      }
      if (resp?.policies) {
        const policies = resp.policies.service_policies || resp.policies;
        const display = $('currentPolicies');
        if (Array.isArray(policies) && policies.length) {
          display.innerHTML = `<div class="policy-source">Current <code>default</code> namespace policies:</div>` +
            policies.map((p) =>
              `<div class="policy-item">${p.name} <span class="policy-ns">(${p.namespace})</span></div>`
            ).join('');
        } else {
          display.innerHTML = `<div class="policy-source">The <code>default</code> namespace has no active service policies.</div>`;
        }
        showStatus('policiesStatus', 'Fetched successfully', 'success');
      } else {
        showStatus('policiesStatus', 'Failed to fetch', 'error');
      }
    } catch {
      showStatus('policiesStatus', 'Could not reach the XC console tab. Open the XC console first.', 'error');
    }
  });

  $('saveExemptions').addEventListener('click', async () => {
    const exemptionMap = collectExemptionMap();
    await setTenantData('exemptionMap', exemptionMap);
    showStatus('exemptionStatus', 'Saved', 'success');
  });

  $('resetExemptions').addEventListener('click', async () => {
    if (selectedTenant) {
      await removeTenantData('exemptionMap');
    } else {
      const resp = await fetch(chrome.runtime.getURL('assets/exemption_map.json'));
      await chrome.storage.local.set({ exemptionMap: await resp.json() });
    }
    await loadTenantConfig();
    showStatus('exemptionStatus', 'Reset to defaults', 'success');
  });

  $('registerLabels').addEventListener('click', async () => {
    showStatus('exemptionStatus', 'Registering labels...', 'success');

    const map = collectExemptionMap();
    const labels = Object.keys(map).map((code) => ({
      key: `xc-audit-${code}`,
      value: 'true',
      description: `Exempts load balancer from ${map[code].label} audit checks`,
    }));
    labels.push({ key: 'xc-audit-baseline-lb', value: 'true', description: 'Marks this load balancer as the audit baseline' });

    try {
      const response = await sendToXcTab({ type: 'REGISTER_LABELS', labels });

      if (response?.error) {
        showStatus('exemptionStatus', response.error, 'error');
        return;
      }

      const r = response?.results || [];
      const created = r.filter((x) => x.status === 'created').length;
      const exists = r.filter((x) => x.status === 'exists').length;
      const errItems = r.filter((x) => x.status === 'error');

      const parts = [];
      if (created) parts.push(`${created} created`);
      if (exists) parts.push(`${exists} already exist`);
      if (errItems.length) parts.push(`${errItems.length} failed`);

      let msg = `Labels: ${parts.join(', ')}`;
      if (errItems.length) {
        msg += '\n' + errItems.map((e) => `  ${e.key}: ${e.detail}`).join('\n');
      }
      showStatus('exemptionStatus', msg, errItems.length ? 'error' : 'success');
    } catch {
      showStatus('exemptionStatus', 'Could not reach the XC console tab. Refresh the page and try again.', 'error');
    }
  });

  $('deleteLabels').addEventListener('click', async () => {
    const tenantLabel = selectedTenant ? shortTenantName(selectedTenant) : 'XC';
    if (!confirm(`Delete all xc-audit labels from ${tenantLabel}? This cannot be undone.`)) return;
    showStatus('exemptionStatus', 'Deleting labels...', 'success');

    const map = collectExemptionMap();
    const labels = Object.keys(map).map((code) => ({
      key: `xc-audit-${code}`,
      value: 'true',
    }));
    labels.push({ key: 'xc-audit-baseline-lb', value: 'true' });

    try {
      const response = await sendToXcTab({ type: 'DELETE_LABELS', labels });

      if (response?.error) {
        showStatus('exemptionStatus', response.error, 'error');
        return;
      }

      const r = response?.results || [];
      const deleted = r.filter((x) => x.status === 'deleted').length;
      const notFound = r.filter((x) => x.status === 'not_found').length;
      const errItems = r.filter((x) => x.status === 'error');

      const parts = [];
      if (deleted) parts.push(`${deleted} deleted`);
      if (notFound) parts.push(`${notFound} not found`);
      if (errItems.length) parts.push(`${errItems.length} failed`);

      let msg = `Labels: ${parts.join(', ')}`;
      if (errItems.length) {
        msg += '\n' + errItems.map((e) => `  ${e.key}: ${e.detail}`).join('\n');
      }
      showStatus('exemptionStatus', msg, errItems.length ? 'error' : 'success');
    } catch {
      showStatus('exemptionStatus', 'Could not reach the XC console tab. Refresh the page and try again.', 'error');
    }
  });

  $('planSelect').addEventListener('change', async () => {
    const config = await getTenantConfig(selectedTenant);
    renderAddons({ ...config.settings, plan: $('planSelect').value });
  });

  $('saveSettings').addEventListener('click', async () => {
    const plan = $('planSelect').value;
    const config = await getTenantConfig(selectedTenant);
    const update = { ...(config.settings || {}), plan };
    const addonToggles = $('addonsContainer').querySelectorAll('input[type="checkbox"]');
    update.addons = [...addonToggles].filter((t) => t.checked).map((t) => t.dataset.addonKey);
    delete update.autoAudit;
    await setTenantData('settings', update);
    showStatus('settingsStatus', 'Plan settings saved', 'success');
  });

  $('saveOtherSettings').addEventListener('click', async () => {
    const { settings: existing } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...existing, autoAudit: $('autoAudit').checked },
    });
    if (selectedTenant) {
      const config = await getTenantConfig(selectedTenant);
      await setTenantData('settings', { ...(config.settings || {}), comparePolicyToDefault: $('comparePolicyToDefault').checked });
    }
    showStatus('otherSettingsStatus', 'Settings saved', 'success');
  });

  $('saveRawJson').addEventListener('click', async () => {
    try {
      const baseline = JSON.parse($('baselineEditor').value);
      $('baselineError').textContent = '';
      const explanations = JSON.parse($('explanationsEditor').value);
      $('explanationsError').textContent = '';
      await setTenantData('baseline', baseline);
      await setTenantData('explanations', explanations);
      renderChecks(baseline);
      renderPolicies();
      showStatus('rawStatus', 'Saved', 'success');
    } catch (e) {
      showStatus('rawStatus', `Invalid JSON: ${e.message}`, 'error');
    }
  });
}

function showStatus(id, message, type) {
  const el = $(id);
  el.textContent = message;
  el.className = `status ${type}`;
}
