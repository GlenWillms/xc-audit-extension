import { api, escapeHtml, goTo } from './app.js';

let tenants = [];
let checkCategoryData = null;

const DEFAULT_SUFFIX = 'console.ves.volterra.io';

async function loadTenants() {
  tenants = await api('/tenants');
}

async function loadCheckCategories() {
  if (!checkCategoryData) {
    checkCategoryData = await api('/assets/check-categories');
  }
  return checkCategoryData;
}

function getAddons(catData) {
  const addonTiers = catData.addonTiers || ['addon', 'enterprise-addon'];
  const categories = catData.categories || [];
  return categories.flatMap(cat =>
    cat.checks.filter(c => addonTiers.includes(c.plan)).map(c => ({ ...c, category: cat.label }))
  );
}

function getPlanIncludes(catData, plan) {
  const planDef = catData.plans?.[plan];
  return new Set(planDef?.includes || ['essentials']);
}

function planOptionsHtml(catData, selected) {
  return Object.entries(catData.plans || {}).map(([id, def]) =>
    `<option value="${escapeHtml(id)}" ${selected === id ? 'selected' : ''}>${escapeHtml(def.label || id)}</option>`
  ).join('');
}

function addonCheckboxesHtml(catData, plan, selectedAddons) {
  const addons = getAddons(catData);
  if (!addons.length) return '';
  const included = getPlanIncludes(catData, plan);
  return `
    <div class="form-group">
      <label>Add-ons</label>
      <div class="form-hint" style="margin-bottom:6px">Enable add-on features purchased separately.</div>
      <div class="addon-container">
        ${addons.map(a => {
          const inc = included.has(a.plan);
          const checked = inc || selectedAddons.includes(a.key);
          return `<label class="addon-row">
            <input type="checkbox" name="addon" value="${escapeHtml(a.key)}" data-plan="${escapeHtml(a.plan)}" ${checked ? 'checked' : ''} ${inc ? 'disabled' : ''}>
            <span>${escapeHtml(a.label)}${inc ? ' (included)' : ''}</span>
            <span class="form-hint" style="margin:0;margin-left:8px">${escapeHtml(a.category)}</span>
          </label>`;
        }).join('')}
      </div>
    </div>
  `;
}

function wireAddonUpdates(catData, planSelectId, addonContainerSelector) {
  const planEl = document.getElementById(planSelectId);
  if (!planEl) return;
  planEl.onchange = () => {
    const included = getPlanIncludes(catData, planEl.value);
    document.querySelectorAll(`${addonContainerSelector} input[name="addon"]`).forEach(cb => {
      const isIncluded = included.has(cb.dataset.plan);
      cb.disabled = isIncluded;
      if (isIncluded) cb.checked = true;
      const span = cb.nextElementSibling;
      const base = span.textContent.replace(/ \(included\)$/, '');
      span.textContent = base + (isIncluded ? ' (included)' : '');
    });
  };
}

function getSelectedAddons(containerSelector) {
  return [...document.querySelectorAll(`${containerSelector} input[name="addon"]:checked:not(:disabled)`)].map(cb => cb.value);
}

// --- Parent tenant form ---

async function renderParentForm(container, existing = null) {
  const isEdit = !!existing;
  const catData = await loadCheckCategories();
  const existingSuffix = existing?.consoleSuffix || DEFAULT_SUFFIX;

  const authType = existing?.p12Path ? 'p12' : 'token';
  container.innerHTML = `
    <div class="card">
      <h2>${isEdit ? 'Edit' : 'Add'} Tenant</h2>
      <form id="tenant-form">
        <div class="form-group">
          <label for="tf-name">Display Name</label>
          <input type="text" id="tf-name" value="${escapeHtml(existing?.name || '')}" placeholder="My Tenant">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="tf-tenant">Tenant Name *</label>
            <input type="text" id="tf-tenant" value="${escapeHtml(existing?.tenant || '')}" placeholder="mycompany-abc123def" required>
            <div class="form-hint">The subdomain from your console URL</div>
          </div>
          <div class="form-group">
            <label for="tf-suffix">Console Suffix</label>
            <input type="text" id="tf-suffix" value="${escapeHtml(existingSuffix)}" placeholder="${DEFAULT_SUFFIX}">
            <div class="form-hint">Default: ${DEFAULT_SUFFIX}</div>
          </div>
        </div>

        <div class="form-group">
          <label>Authentication *</label>
          <div class="auth-toggle">
            <label class="auth-option"><input type="radio" name="auth-type" value="p12" ${authType === 'p12' ? 'checked' : ''}> API Certificate (p12)</label>
            <label class="auth-option"><input type="radio" name="auth-type" value="token" ${authType === 'token' ? 'checked' : ''}> API Token</label>
          </div>
        </div>
        <div id="auth-p12" class="auth-section" ${authType !== 'p12' ? 'style="display:none"' : ''}>
          <div class="form-group">
            <label for="tf-p12path">P12 File Path *</label>
            <input type="text" id="tf-p12path" value="${escapeHtml(existing?.p12Path || '')}" placeholder="/path/to/api-creds.p12">
            <div class="form-hint">Absolute path to the .p12 certificate file on this machine</div>
          </div>
          <div class="form-group">
            <label for="tf-p12pass">P12 Password</label>
            <input type="password" id="tf-p12pass" placeholder="${isEdit && existing?.p12Path ? '(unchanged)' : 'Certificate password'}">
            <div class="form-hint">Leave blank if no password</div>
          </div>
        </div>
        <div id="auth-token" class="auth-section" ${authType !== 'token' ? 'style="display:none"' : ''}>
          <div class="form-group">
            <label for="tf-apitoken">API Token *</label>
            <input type="password" id="tf-apitoken" placeholder="${isEdit && existing?.apiToken ? '(unchanged)' : 'Enter API token'}">
            <div class="form-hint">Generate at Administration &rarr; Personal Management &rarr; Credentials &rarr; API Token</div>
          </div>
        </div>

        <div class="form-group">
          <label for="tf-plan">Plan Tier</label>
          <select id="tf-plan">${planOptionsHtml(catData, existing?.plan || 'essentials')}</select>
          <div class="form-hint">Controls which checks are active.</div>
        </div>
        <div id="tf-addons">${addonCheckboxesHtml(catData, existing?.plan || 'essentials', existing?.addons || [])}</div>
        <div id="tf-error"></div>
        <div class="form-actions">
          <button type="submit" class="btn-primary">${isEdit ? 'Save' : 'Add Tenant'}</button>
          <button type="button" class="btn-secondary" id="tf-cancel">Cancel</button>
          <button type="button" class="btn-secondary" id="tf-test" style="margin-left:auto">Test Connection</button>
        </div>
      </form>
    </div>
  `;

  // Toggle auth sections
  document.querySelectorAll('input[name="auth-type"]').forEach(radio => {
    radio.onchange = () => {
      document.getElementById('auth-p12').style.display = radio.value === 'p12' ? '' : 'none';
      document.getElementById('auth-token').style.display = radio.value === 'token' ? '' : 'none';
    };
  });

  wireAddonUpdates(catData, 'tf-plan', '#tf-addons');
  document.getElementById('tf-cancel').onclick = () => renderTenants(container.closest('.view'));

  document.getElementById('tf-test').onclick = async () => {
    const errEl = document.getElementById('tf-error');
    const tenant = document.getElementById('tf-tenant').value.trim();
    const cred = getCredential();
    if (!tenant) {
      errEl.innerHTML = '<div class="alert alert-error">Tenant name is required</div>';
      return;
    }
    if (!cred.p12Path && !cred.apiToken && !isEdit) {
      errEl.innerHTML = '<div class="alert alert-error">Credential is required</div>';
      return;
    }
    errEl.innerHTML = '<div class="alert"><span class="spinner"></span> Testing connection...</div>';

    if (isEdit && existing?.id) {
      try {
        const updates = buildUpdates();
        if (Object.keys(updates).length) await api(`/tenants/${existing.id}`, { method: 'PUT', body: updates });
        const ns = await api(`/tenants/${existing.id}/namespaces`);
        errEl.innerHTML = `<div class="alert alert-success">Connected. Found ${ns.length} namespaces.</div>`;
      } catch (err) {
        errEl.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
      }
    } else {
      try {
        const temp = await api('/tenants', { method: 'POST', body: { name: '__test__', ...buildNew() } });
        try {
          const ns = await api(`/tenants/${temp.id}/namespaces`);
          errEl.innerHTML = `<div class="alert alert-success">Connected. Found ${ns.length} namespaces.</div>`;
        } finally {
          await api(`/tenants/${temp.id}`, { method: 'DELETE' }).catch(() => {});
        }
      } catch (err) {
        errEl.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
      }
    }
  };

  function getCredential() {
    const authType = document.querySelector('input[name="auth-type"]:checked')?.value || 'p12';
    if (authType === 'p12') {
      return {
        p12Path: document.getElementById('tf-p12path').value.trim(),
        p12Password: document.getElementById('tf-p12pass').value,
        apiToken: null,
      };
    }
    return {
      p12Path: null,
      p12Password: '',
      apiToken: document.getElementById('tf-apitoken').value.trim(),
    };
  }

  function buildNew() {
    return {
      tenant: document.getElementById('tf-tenant').value.trim(),
      ...getCredential(),
      consoleSuffix: document.getElementById('tf-suffix').value.trim() || DEFAULT_SUFFIX,
      plan: document.getElementById('tf-plan').value,
      addons: getSelectedAddons('#tf-addons'),
    };
  }

  function buildUpdates() {
    const u = {};
    const name = document.getElementById('tf-name').value.trim();
    const tenant = document.getElementById('tf-tenant').value.trim();
    const cred = getCredential();
    if (name) u.name = name;
    if (tenant) u.tenant = tenant;
    if (cred.p12Path) u.p12Path = cred.p12Path;
    if (cred.p12Password) u.p12Password = cred.p12Password;
    if (cred.apiToken) u.apiToken = cred.apiToken;
    // Clear the other auth type
    if (cred.p12Path) u.apiToken = null;
    if (cred.apiToken) { u.p12Path = null; u.p12Password = ''; }
    u.consoleSuffix = document.getElementById('tf-suffix').value.trim() || DEFAULT_SUFFIX;
    u.plan = document.getElementById('tf-plan').value;
    u.addons = getSelectedAddons('#tf-addons');
    return u;
  }

  document.getElementById('tenant-form').onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('tf-error');
    const tenant = document.getElementById('tf-tenant').value.trim();
    const cred = getCredential();
    if (!tenant) { errEl.innerHTML = '<div class="alert alert-error">Tenant name is required</div>'; return; }
    if (!isEdit && !cred.p12Path && !cred.apiToken) { errEl.innerHTML = '<div class="alert alert-error">Credential is required</div>'; return; }
    try {
      if (isEdit) {
        await api(`/tenants/${existing.id}`, { method: 'PUT', body: buildUpdates() });
      } else {
        const name = document.getElementById('tf-name').value.trim();
        await api('/tenants', { method: 'POST', body: { name: name || tenant, ...buildNew() } });
      }
      renderTenants(container.closest('.view'));
    } catch (err) {
      errEl.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  };
}

// --- Managed tenant form ---

async function renderManagedForm(container, parent, existing = null) {
  const isEdit = !!existing;
  const catData = await loadCheckCategories();

  container.innerHTML = `
    <div class="card">
      <h2>${isEdit ? 'Edit' : 'Add'} Managed Tenant</h2>
      <div class="form-hint" style="margin-bottom:12px">Under <strong>${escapeHtml(parent.name || parent.tenant)}</strong> &mdash; inherits API key and console suffix</div>
      <form id="managed-form">
        <div class="form-row">
          <div class="form-group">
            <label for="mf-name">Display Name</label>
            <input type="text" id="mf-name" value="${escapeHtml(existing?.name || '')}" placeholder="Child Tenant">
          </div>
          <div class="form-group">
            <label for="mf-tenant">Managed Tenant ID *</label>
            <input type="text" id="mf-tenant" value="${escapeHtml(existing?.tenant || '')}" placeholder="child-tenant-name" required>
            <div class="form-hint">The managed tenant identifier in XC</div>
          </div>
        </div>
        <div class="form-group">
          <label for="mf-plan">Plan Tier</label>
          <select id="mf-plan">${planOptionsHtml(catData, existing?.plan || parent.plan || 'essentials')}</select>
          <div class="form-hint">Defaults to parent plan if unchanged.</div>
        </div>
        <div id="mf-addons">${addonCheckboxesHtml(catData, existing?.plan || parent.plan || 'essentials', existing?.addons || parent.addons || [])}</div>
        <div id="mf-error"></div>
        <div class="form-actions">
          <button type="submit" class="btn-primary">${isEdit ? 'Save' : 'Add Managed Tenant'}</button>
          <button type="button" class="btn-secondary" id="mf-cancel">Cancel</button>
        </div>
      </form>
    </div>
  `;

  wireAddonUpdates(catData, 'mf-plan', '#mf-addons');
  document.getElementById('mf-cancel').onclick = () => renderTenants(container.closest('.view'));

  document.getElementById('managed-form').onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('mf-error');
    const tenant = document.getElementById('mf-tenant').value.trim();
    if (!tenant) { errEl.innerHTML = '<div class="alert alert-error">Managed tenant ID is required</div>'; return; }
    const name = document.getElementById('mf-name').value.trim();
    const plan = document.getElementById('mf-plan').value;
    const addons = getSelectedAddons('#mf-addons');
    try {
      if (isEdit) {
        await api(`/tenants/${parent.id}/managed/${existing.id}`, { method: 'PUT', body: { name, tenant, plan, addons } });
      } else {
        await api(`/tenants/${parent.id}/managed`, { method: 'POST', body: { name: name || tenant, tenant, plan, addons } });
      }
      renderTenants(container.closest('.view'));
    } catch (err) {
      errEl.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  };
}

// --- Tenant list ---

export async function renderTenants(container) {
  try {
    await loadTenants();
  } catch {
    tenants = [];
  }

  if (tenants.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No tenants configured yet.</p>
        <button class="btn-primary" id="add-tenant-btn">Add Tenant</button>
      </div>
    `;
    document.getElementById('add-tenant-btn').onclick = () => renderParentForm(container);
    return;
  }

  let html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2>Tenants</h2>
      <button class="btn-primary btn-sm" id="add-tenant-btn">+ Add Tenant</button>
    </div>
  `;

  for (const t of tenants) {
    const suffix = t.consoleSuffix || DEFAULT_SUFFIX;
    const managed = t.managedTenants || [];

    html += `
      <div class="card tenant-card" data-id="${t.id}">
        <div class="card-header">
          <div>
            <div class="card-title">${escapeHtml(t.name || t.tenant)}</div>
            <div class="card-subtitle">${escapeHtml(t.tenant)}.${escapeHtml(suffix)}</div>
          </div>
          <div class="card-actions">
            <button class="btn-sm btn-secondary add-managed-btn" data-id="${t.id}">+ Managed</button>
            <button class="btn-sm btn-secondary edit-btn" data-id="${t.id}">Edit</button>
            <button class="btn-sm btn-danger delete-btn" data-id="${t.id}">Delete</button>
          </div>
        </div>
        <div class="card-meta">
          <span class="tag tag-plan">${escapeHtml(t.plan || 'essentials')}</span>
          ${(t.addons?.length) ? `<span class="tag tag-plan">${t.addons.length} add-on${t.addons.length > 1 ? 's' : ''}</span>` : ''}
          ${t.p12Path ? `<span style="color:#2b8a3e;font-size:11px">p12: ${escapeHtml(t.p12Path.split('/').pop())}</span>` : t.hasCredential ? '<span style="color:#2b8a3e;font-size:11px">API token configured</span>' : '<span style="color:#c92a2a;font-size:11px">No credentials</span>'}
        </div>
    `;

    if (managed.length) {
      html += '<div class="managed-list">';
      for (const m of managed) {
        html += `
          <div class="managed-item" data-parent="${t.id}" data-id="${m.id}">
            <div class="managed-info">
              <span class="managed-name">${escapeHtml(m.name || m.tenant)}</span>
              <span class="managed-id">${escapeHtml(m.tenant)}</span>
            </div>
            <div class="card-meta" style="margin:0">
              <span class="tag tag-plan" style="font-size:10px">${escapeHtml(m.plan || t.plan || 'essentials')}</span>
            </div>
            <div class="card-actions">
              <button class="btn-sm btn-secondary edit-managed-btn" data-parent="${t.id}" data-id="${m.id}">Edit</button>
              <button class="btn-sm btn-danger delete-managed-btn" data-parent="${t.id}" data-id="${m.id}">Delete</button>
            </div>
          </div>
        `;
      }
      html += '</div>';
    }

    html += '</div>';
  }

  container.innerHTML = html;

  document.getElementById('add-tenant-btn').onclick = () => renderParentForm(container);

  container.querySelectorAll('.edit-btn').forEach(btn => {
    btn.onclick = () => {
      const t = tenants.find(t => t.id === btn.dataset.id);
      if (t) renderParentForm(container, t);
    };
  });

  container.querySelectorAll('.delete-btn').forEach(btn => {
    btn.onclick = async () => {
      const t = tenants.find(t => t.id === btn.dataset.id);
      const count = (t?.managedTenants || []).length;
      const msg = count ? `Delete this tenant and its ${count} managed tenant${count > 1 ? 's' : ''}?` : 'Delete this tenant?';
      if (!confirm(msg)) return;
      try {
        await api(`/tenants/${btn.dataset.id}`, { method: 'DELETE' });
        renderTenants(container);
      } catch {}
    };
  });

  container.querySelectorAll('.add-managed-btn').forEach(btn => {
    btn.onclick = () => {
      const t = tenants.find(t => t.id === btn.dataset.id);
      if (t) renderManagedForm(container, t);
    };
  });

  container.querySelectorAll('.edit-managed-btn').forEach(btn => {
    btn.onclick = () => {
      const t = tenants.find(t => t.id === btn.dataset.parent);
      const m = t?.managedTenants?.find(m => m.id === btn.dataset.id);
      if (t && m) renderManagedForm(container, t, m);
    };
  });

  container.querySelectorAll('.delete-managed-btn').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Delete this managed tenant?')) return;
      try {
        await api(`/tenants/${btn.dataset.parent}/managed/${btn.dataset.id}`, { method: 'DELETE' });
        renderTenants(container);
      } catch {}
    };
  });
}
