import { api, escapeHtml, goTo } from './app.js';

let tenants = [];
let namespaces = [];

async function loadTenants() {
  tenants = await api('/tenants');
}

function buildTargetOptions() {
  const options = [];
  for (const t of tenants) {
    options.push({
      label: t.name || t.tenant,
      nsPath: `/tenants/${t.id}/namespaces`,
      auditPath: `/tenants/${t.id}/audit`,
    });
    for (const m of t.managedTenants || []) {
      options.push({
        label: `${t.name || t.tenant} → ${m.name || m.tenant}`,
        nsPath: `/tenants/${t.id}/managed/${m.id}/namespaces`,
        auditPath: `/tenants/${t.id}/managed/${m.id}/audit`,
      });
    }
  }
  return options;
}

async function loadNamespaces(nsPath) {
  namespaces = await api(nsPath);
}

function renderNamespaceList(container) {
  if (namespaces.length === 0) {
    container.innerHTML = '<div class="form-hint">No namespaces found. Check the API key permissions.</div>';
    return;
  }

  let html = `
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <button class="btn-sm btn-secondary" id="ns-select-all">Select All</button>
      <button class="btn-sm btn-secondary" id="ns-select-none">Select None</button>
      <span class="form-hint" style="align-self:center">${namespaces.length} namespaces</span>
    </div>
    <div class="ns-list">
  `;

  for (const ns of namespaces.sort()) {
    html += `
      <label class="ns-item">
        <input type="checkbox" name="ns" value="${escapeHtml(ns)}" checked>
        ${escapeHtml(ns)}
      </label>
    `;
  }

  html += '</div>';
  container.innerHTML = html;

  document.getElementById('ns-select-all').onclick = () => {
    container.querySelectorAll('input[name="ns"]').forEach(cb => cb.checked = true);
  };
  document.getElementById('ns-select-none').onclick = () => {
    container.querySelectorAll('input[name="ns"]').forEach(cb => cb.checked = false);
  };
}

function getSelectedNamespaces() {
  return [...document.querySelectorAll('input[name="ns"]:checked')].map(cb => cb.value);
}

function logEntry(logEl, message) {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(message)}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderSummary(container, result) {
  const s = result.summary;
  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${s.namespaceCount}</div>
        <div class="stat-label">Namespaces</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${s.totalLbs}</div>
        <div class="stat-label">Load Balancers</div>
      </div>
      <div class="stat-card stat-pass">
        <div class="stat-value">${s.passing}</div>
        <div class="stat-label">Passing</div>
      </div>
      <div class="stat-card stat-warn">
        <div class="stat-value">${s.warnings}</div>
        <div class="stat-label">Warnings</div>
      </div>
      <div class="stat-card stat-pct">
        <div class="stat-value">${s.compliance}%</div>
        <div class="stat-label">Compliance</div>
      </div>
      ${(s.quotaWarnings || s.quotaNotices) ? `
      <div class="stat-card ${s.quotaWarnings ? 'stat-warn' : 'stat-quota-notice'}">
        <div class="stat-value">${(s.quotaWarnings || 0) + (s.quotaNotices || 0)}</div>
        <div class="stat-label">Quota Alerts</div>
      </div>` : ''}
    </div>
    <div class="form-actions">
      <button class="btn-primary" id="view-report-btn">View Full Report</button>
      <button class="btn-secondary" id="download-report-btn">Download HTML</button>
    </div>
  `;

  document.getElementById('view-report-btn').onclick = () => goTo('report');
  document.getElementById('download-report-btn').onclick = () => downloadReport(result.reportHtml);
}

function downloadReport(html) {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `xc-audit-report-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function renderAudit(container) {
  try {
    await loadTenants();
  } catch {
    tenants = [];
  }

  const targets = buildTargetOptions();

  if (targets.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No tenants configured. Add a tenant first.</p>
        <button class="btn-primary" onclick="location.hash='tenants'">Go to Tenants</button>
      </div>
    `;
    return;
  }

  let html = `
    <h2>Run Audit</h2>
    <div class="card">
      <div class="form-group">
        <label for="audit-target">Tenant</label>
        <select id="audit-target">
          <option value="">Select a tenant...</option>
          ${targets.map((t, i) => `<option value="${i}">${escapeHtml(t.label)}</option>`).join('')}
        </select>
      </div>
      <div id="ns-container" style="display:none">
        <label>Namespaces</label>
        <div id="ns-list-inner"></div>
      </div>
      <div id="audit-error"></div>
      <div class="form-actions">
        <button class="btn-primary" id="run-audit-btn" disabled>Run Audit</button>
        <button class="btn-secondary" id="refresh-ns-btn" style="display:none">Refresh Namespaces</button>
      </div>
    </div>
    <div id="audit-progress" style="display:none">
      <div class="card">
        <div class="progress-container">
          <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
          <div class="progress-text" id="progress-text">Starting audit...</div>
        </div>
        <div class="audit-log" id="audit-log"></div>
      </div>
    </div>
    <div id="audit-summary"></div>
  `;

  container.innerHTML = html;

  const targetSelect = document.getElementById('audit-target');
  const nsContainer = document.getElementById('ns-container');
  const nsListInner = document.getElementById('ns-list-inner');
  const runBtn = document.getElementById('run-audit-btn');
  const refreshBtn = document.getElementById('refresh-ns-btn');
  const errEl = document.getElementById('audit-error');

  let currentTarget = null;

  async function onTargetChange() {
    const idx = targetSelect.value;
    if (idx === '') {
      nsContainer.style.display = 'none';
      runBtn.disabled = true;
      refreshBtn.style.display = 'none';
      currentTarget = null;
      return;
    }

    currentTarget = targets[parseInt(idx)];
    nsListInner.innerHTML = '<span class="spinner"></span> Loading namespaces...';
    nsContainer.style.display = 'block';
    refreshBtn.style.display = 'inline-flex';
    errEl.innerHTML = '';

    try {
      await loadNamespaces(currentTarget.nsPath);
      renderNamespaceList(nsListInner);
      runBtn.disabled = false;
    } catch (err) {
      nsListInner.innerHTML = '';
      errEl.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
      runBtn.disabled = true;
    }
  }

  targetSelect.onchange = onTargetChange;
  refreshBtn.onclick = onTargetChange;

  runBtn.onclick = async () => {
    if (!currentTarget) return;
    const selected = getSelectedNamespaces();
    if (selected.length === 0) {
      errEl.innerHTML = '<div class="alert alert-error">Select at least one namespace</div>';
      return;
    }

    errEl.innerHTML = '';
    runBtn.disabled = true;
    targetSelect.disabled = true;

    const progressEl = document.getElementById('audit-progress');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const logEl = document.getElementById('audit-log');
    const summaryEl = document.getElementById('audit-summary');

    progressEl.style.display = 'block';
    summaryEl.innerHTML = '';
    logEl.innerHTML = '';
    progressFill.style.width = '0%';

    logEntry(logEl, `Starting audit of ${selected.length} namespace(s)...`);

    try {
      const resp = await fetch(`/api${currentTarget.auditPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespaces: selected }),
      });

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completeResult = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.type === 'progress') {
              progressText.textContent = event.message;
              logEntry(logEl, event.message);
              const match = event.message.match(/(\d+) of (\d+)/);
              if (match) {
                const pct = Math.round((parseInt(match[1]) / parseInt(match[2])) * 100);
                progressFill.style.width = `${pct}%`;
              }
            } else if (event.type === 'complete') {
              completeResult = event;
              window.__lastAuditResult = event;
              progressFill.style.width = '100%';
              progressText.textContent = 'Audit complete';
              logEntry(logEl, 'Audit complete.');
            } else if (event.type === 'error') {
              logEntry(logEl, `Error: ${event.message}`);
              errEl.innerHTML = `<div class="alert alert-error">${escapeHtml(event.message)}</div>`;
            }
          } catch {}
        }
      }

      if (completeResult) {
        renderSummary(summaryEl, completeResult);
      }
    } catch (err) {
      errEl.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
      logEntry(logEl, `Error: ${err.message}`);
    }

    runBtn.disabled = false;
    targetSelect.disabled = false;
  };
}
