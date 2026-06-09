const $ = (id) => document.getElementById(id);

const CHECK_REGISTRY = [
  { category: 'TLS & Encryption', key: '__ONE_OF__tls_hsts', label: 'TLS / HSTS', code: 'ignore-tls' },
  { category: 'Web Application Firewall', key: 'app_firewall', label: 'App Firewall', code: 'ignore-waf' },
  { category: 'DDoS Protection', key: 'ddos_mitigation_rules', label: 'DDoS Mitigation Rules', code: 'ignore-ddos' },
  { category: 'DDoS Protection', key: 'l7_ddos_protection', label: 'L7 DDoS Protection', code: 'ignore-ddos' },
  { category: 'API Security', key: 'disable_api_discovery', label: 'API Discovery', code: 'ignore-apid' },
  { category: 'API Security', key: 'disable_api_definition', label: 'API Definition', code: 'ignore-apip' },
  { category: 'API Security', key: 'disable_api_testing', label: 'API Testing', code: 'ignore-apip' },
  { category: 'Bot & Client Protection', key: 'disable_bot_defense', label: 'Bot Defense', code: 'ignore-bot' },
  { category: 'Bot & Client Protection', key: 'disable_client_side_defense', label: 'Client-Side Defense', code: 'ignore-csd' },
  { category: 'Bot & Client Protection', key: 'disable_ip_reputation', label: 'IP Reputation', code: 'ignore-iprep' },
  { category: 'Policy & Data', key: 'service_policies_from_namespace', label: 'Service Policies (from namespace)', code: 'ignore-sp' },
  { category: 'Policy & Data', key: 'default_sensitive_data_policy', label: 'Sensitive Data Policy', code: 'ignore-sdp' },
  { category: 'Policy & Data', key: 'disable_trust_client_ip_headers', label: 'Trust Client IP Headers', code: 'ignore-trustip' },
];

document.addEventListener('DOMContentLoaded', loadAll);

async function loadAll() {
  const { baseline, explanations, exemptionMap, settings } =
    await chrome.storage.local.get(['baseline', 'explanations', 'exemptionMap', 'settings']);

  renderChecks(baseline);
  renderPolicies(baseline);
  renderExemptionMap(exemptionMap || {});
  renderRawJson(baseline, explanations);

  const s = settings || {};
  $('autoAudit').checked = s.autoAudit !== false;

  bindEvents();
}

function renderChecks(baseline) {
  const spec = baseline?.lb_baseline?.spec || {};
  const container = $('checksContainer');
  container.innerHTML = '';

  const categories = {};
  for (const check of CHECK_REGISTRY) {
    if (!categories[check.category]) categories[check.category] = [];
    categories[check.category].push(check);
  }

  for (const [cat, checks] of Object.entries(categories)) {
    const group = document.createElement('div');
    group.className = 'check-group';

    const header = document.createElement('div');
    header.className = 'check-group-header';
    header.textContent = cat;
    group.appendChild(header);

    for (const check of checks) {
      const row = document.createElement('label');
      row.className = 'check-row';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = check.key in spec;
      toggle.dataset.key = check.key;

      const info = document.createElement('div');
      info.className = 'check-info';
      info.innerHTML = `<span class="check-label">${check.label}</span>` +
        `<span class="check-code">Label: <code>${check.code}</code></span>`;

      row.appendChild(toggle);
      row.appendChild(info);
      group.appendChild(row);
    }

    container.appendChild(group);
  }
}

function renderPolicies(baseline) {
  const policies = baseline?.namespace_baseline?.service_policies || [];
  $('policiesEditor').value = JSON.stringify(policies, null, 2);
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

    b.lb_baseline.spec = newSpec;
    return b;
  });
}

function collectPolicies() {
  const text = $('policiesEditor').value;
  return JSON.parse(text);
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

function bindEvents() {
  $('saveChecks').addEventListener('click', async () => {
    const baseline = await collectChecksToBaseline();
    try {
      const policies = collectPolicies();
      baseline.namespace_baseline = { service_policies: policies };
    } catch {}
    await chrome.storage.local.set({ baseline });
    renderRawJson(baseline, null);
    showStatus('checksStatus', 'Saved', 'success');
  });

  $('resetChecks').addEventListener('click', async () => {
    const resp = await fetch(chrome.runtime.getURL('assets/baseline_lb_http.json'));
    const baseline = await resp.json();
    await chrome.storage.local.set({ baseline });
    renderChecks(baseline);
    renderPolicies(baseline);
    renderRawJson(baseline, null);
    showStatus('checksStatus', 'Reset to defaults', 'success');
  });

  $('savePolicies').addEventListener('click', async () => {
    try {
      const policies = collectPolicies();
      const { baseline = {} } = await chrome.storage.local.get('baseline');
      baseline.namespace_baseline = { service_policies: policies };
      await chrome.storage.local.set({ baseline });
      $('policiesError').textContent = '';
      showStatus('policiesStatus', 'Saved', 'success');
    } catch (e) {
      $('policiesError').textContent = `Invalid JSON: ${e.message}`;
    }
  });

  $('resetPolicies').addEventListener('click', async () => {
    const resp = await fetch(chrome.runtime.getURL('assets/baseline_lb_http.json'));
    const baseline = await resp.json();
    const { baseline: current = {} } = await chrome.storage.local.get('baseline');
    current.namespace_baseline = baseline.namespace_baseline;
    await chrome.storage.local.set({ baseline: current });
    renderPolicies(current);
    showStatus('policiesStatus', 'Reset to default', 'success');
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
      const errors = r.filter((x) => x.status === 'error').length;

      const parts = [];
      if (created) parts.push(`${created} created`);
      if (exists) parts.push(`${exists} already exist`);
      if (errors) parts.push(`${errors} failed`);

      showStatus('exemptionStatus', `Labels registered: ${parts.join(', ')}`, errors ? 'error' : 'success');
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
