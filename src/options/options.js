const $ = (id) => document.getElementById(id);

let CHECK_CATEGORIES = [];
let CHECK_REGISTRY = [];

async function loadCategories() {
  const resp = await fetch(chrome.runtime.getURL('assets/check-categories.json'));
  CHECK_CATEGORIES = await resp.json();
  CHECK_REGISTRY = CHECK_CATEGORIES.flatMap((cat) =>
    cat.checks.map((check) => ({ ...check, category: cat.label, categoryId: cat.id }))
  );
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadCategories();
  loadAll();
});

async function loadAll() {
  const { baseline, explanations, exemptionMap, settings } =
    await chrome.storage.local.get(['baseline', 'explanations', 'exemptionMap', 'settings']);

  renderChecks(baseline);
  renderPolicies();
  renderExemptionMap(exemptionMap || {});
  renderRawJson(baseline, explanations);

  const s = settings || {};
  $('autoAudit').checked = s.autoAudit !== false;

  bindEvents();
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
  const { baseline, policyOverrides } = await chrome.storage.local.get(['baseline', 'policyOverrides']);
  const staticPolicies = baseline?.namespace_baseline?.service_policies;

  if (staticPolicies && Array.isArray(staticPolicies) && staticPolicies.length) {
    container.innerHTML = `<div class="policy-source">Static fallback baseline:</div>` +
      staticPolicies.map((p) =>
        `<div class="policy-item">${p.name} <span class="policy-ns">(${p.namespace})</span></div>`
      ).join('');
  } else {
    container.innerHTML = `<div class="policy-source">Policy baseline is fetched dynamically from the <code>default</code> namespace at audit time.</div>`;
  }

  const overrides = policyOverrides || {};
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
        await chrome.storage.local.set({ policyOverrides: overrides });
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

function collectChecksToBaseline() {
  return chrome.storage.local.get('baseline').then(({ baseline }) => {
    const b = baseline || {};
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
  });
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
  const [baselineResp, explanationsResp, exemptionResp] = await Promise.all([
    fetch(chrome.runtime.getURL('assets/baseline_lb_http.json')),
    fetch(chrome.runtime.getURL('assets/explanations.json')),
    fetch(chrome.runtime.getURL('assets/exemption_map.json')),
  ]);
  const baseline = await baselineResp.json();
  const explanations = await explanationsResp.json();
  const exemptionMap = await exemptionResp.json();

  await chrome.storage.local.set({
    baseline,
    explanations,
    exemptionMap,
    settings: { autoAudit: true },
  });
  await chrome.storage.local.remove('policyOverrides');

  renderChecks(baseline);
  renderPolicies();
  renderExemptionMap(exemptionMap);
  renderRawJson(baseline, explanations);
  $('autoAudit').checked = true;
}

function bindEvents() {
  $('resetAll').addEventListener('click', async () => {
    if (!confirm('Reset all settings to defaults? This will clear any customizations and namespace policy overrides.')) return;
    await resetAllToDefaults();
    showStatus('resetAllStatus', 'All settings reset to defaults', 'success');
  });

  $('saveChecks').addEventListener('click', async () => {
    const baseline = await collectChecksToBaseline();
    await chrome.storage.local.set({ baseline });
    renderRawJson(baseline, null);
    showStatus('checksStatus', 'Saved', 'success');
  });

  $('resetChecks').addEventListener('click', async () => {
    const resp = await fetch(chrome.runtime.getURL('assets/baseline_lb_http.json'));
    const baseline = await resp.json();
    await chrome.storage.local.set({ baseline });
    renderChecks(baseline);
    renderPolicies();
    renderRawJson(baseline, null);
    showStatus('checksStatus', 'Reset to defaults', 'success');
  });

  $('fetchDefaultPolicies').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: 'https://*.console.ves.volterra.io/*' });
    if (!tabs.length) {
      showStatus('policiesStatus', 'No XC console tab open. Open the XC console first.', 'error');
      return;
    }
    showStatus('policiesStatus', 'Fetching...', 'success');
    try {
      const resp = await chrome.tabs.sendMessage(tabs[0].id, {
        type: 'GET_POLICIES', namespace: 'default',
      });
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
        showStatus('policiesStatus', resp?.error || 'Failed to fetch', 'error');
      }
    } catch {
      showStatus('policiesStatus', 'Could not reach the XC console tab.', 'error');
    }
  });

  $('saveExemptions').addEventListener('click', async () => {
    const exemptionMap = collectExemptionMap();
    await chrome.storage.local.set({ exemptionMap });
    showStatus('exemptionStatus', 'Saved', 'success');
  });

  $('resetExemptions').addEventListener('click', async () => {
    const resp = await fetch(chrome.runtime.getURL('assets/exemption_map.json'));
    const exemptionMap = await resp.json();
    await chrome.storage.local.set({ exemptionMap });
    renderExemptionMap(exemptionMap);
    showStatus('exemptionStatus', 'Reset to defaults', 'success');
  });

  $('registerLabels').addEventListener('click', async () => {
    showStatus('exemptionStatus', 'Registering labels...', 'success');

    const map = collectExemptionMap();
    const labels = Object.keys(map).map((code) => ({
      key: `xc-audit-${code}`,
      value: 'true',
    }));

    const tabs = await chrome.tabs.query({ url: 'https://*.console.ves.volterra.io/*' });
    if (!tabs.length) {
      showStatus('exemptionStatus', 'No XC console tab open. Open the XC console first.', 'error');
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tabs[0].id, {
        type: 'REGISTER_LABELS',
        labels,
      });

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

  $('saveSettings').addEventListener('click', async () => {
    await chrome.storage.local.set({
      settings: { autoAudit: $('autoAudit').checked },
    });
    showStatus('settingsStatus', 'Settings saved', 'success');
  });

  $('saveRawJson').addEventListener('click', async () => {
    try {
      const baseline = JSON.parse($('baselineEditor').value);
      $('baselineError').textContent = '';
      const explanations = JSON.parse($('explanationsEditor').value);
      $('explanationsError').textContent = '';
      await chrome.storage.local.set({ baseline, explanations });
      renderChecks(baseline);
      renderPolicies(baseline);
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
