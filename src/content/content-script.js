(() => {
  let lastUrl = location.href;
  let auditResults = null;
  let debounceTimer = null;
  let currentManagedTenant = null;

  // --- Initialization ---

  function init() {
    checkPage();

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'TRIGGER_REAUDIT') {
        removeAllBadges();
        chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, () => checkPage(true));
      }
      if (message.type === 'REGISTER_LABELS') {
        registerLabels(message.labels).then(sendResponse);
        return true;
      }
      if (message.type === 'GET_POLICIES') {
        fetchPolicies(message.namespace).then(sendResponse);
        return true;
      }
    });

    const titleEl = document.querySelector('head > title') || document.head;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        checkPage();
      }
    }).observe(titleEl, { childList: true, subtree: true, characterData: true });

    window.addEventListener('popstate', () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        checkPage();
      }
    });

    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        checkPage();
      }
    }, 1000);
  }

  function checkPage(force) {
    const parsed = parseXcUrl(location.href);
    if (!parsed || !parsed.isLbListPage) {
      removeAllBadges();
      return;
    }
    requestAudit(parsed.tenant, parsed.namespace, parsed.managedTenant, force);
  }

  async function getCsrf(retries = 10) {
    for (let i = 0; i < retries; i++) {
      const { csrf } = await chrome.runtime.sendMessage({ type: 'GET_CSRF' });
      if (csrf) return csrf;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  async function requestAudit(tenant, namespace, managedTenant, force) {
    try {
      currentManagedTenant = managedTenant;
      const csrf = await getCsrf();
      if (!csrf) return;

      const apiPrefix = managedTenant ? `/managed_tenant/${managedTenant}` : '';

      function apiUrl(path) {
        return `${apiPrefix}${path}?report_fields&csrf=${csrf}`;
      }

      const [policies, defaultPolicies, lbListResp] = await Promise.all([
        fetch(apiUrl(`/api/config/namespaces/${namespace}/active_service_policies`))
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch(apiUrl(`/api/config/namespaces/default/active_service_policies`))
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch(apiUrl(`/api/config/namespaces/${namespace}/http_loadbalancers`)),
      ]);

      if (!lbListResp.ok) throw new Error(`API ${lbListResp.status}`);
      const lbList = (await lbListResp.json()).items || [];

      const lbVersions = lbList.map((lb) => ({
        name: lb.name,
        version: lb.resource_version || lb.metadata?.resource_version || null,
      }));

      let staleLbs = lbVersions.map((v) => v.name);
      let freshResults = {};

      if (!force) {
        const check = await chrome.runtime.sendMessage({
          type: 'CHECK_VERSIONS', tenant, namespace, managedTenant, lbVersions,
        });
        if (check) {
          staleLbs = check.stale || [];
          freshResults = check.fresh || {};
        }
      }

      const lbConfigs = (
        await Promise.all(
          staleLbs.map((name) =>
            fetch(apiUrl(`/api/config/namespaces/${namespace}/http_loadbalancers/${name}`))
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          )
        )
      ).filter(Boolean);

      chrome.runtime.sendMessage(
        {
          type: force ? 'FORCE_RUN_AUDIT' : 'RUN_AUDIT',
          tenant, namespace, managedTenant, policies, defaultPolicies, lbConfigs, lbVersions,
        },
        (response) => {
          if (chrome.runtime.lastError) return;
          if (response?.type === 'AUDIT_RESULTS') {
            const data = response.data;
            for (const [name, result] of Object.entries(freshResults)) {
              if (!data.loadBalancers.find((lb) => lb.name === name)) {
                data.loadBalancers.push(result);
              }
            }
            auditResults = data;
            observeAndInject();
          }
        }
      );
    } catch (err) {
      if (err.message?.includes('401') || err.message?.includes('403')) {
        showSessionBanner();
      }
    }
  }

  function observeAndInject() {
    injectBadges();

    const contentArea = document.querySelector('[class*="content"]') || document.body;
    new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(injectBadges, 200);
    }).observe(contentArea, { childList: true, subtree: true });
  }

  function findLbRows() {
    const rows = [];
    document.querySelectorAll('vs-stellar-crud-common').forEach((crudEl) => {
      const nameSpan = crudEl.querySelector('span');
      if (!nameSpan) return;
      const wrapper = crudEl.closest('datatable-row-wrapper');
      const bodyRow = crudEl.closest('datatable-body-row');
      if (wrapper && bodyRow) {
        rows.push({ wrapper, bodyRow, nameEl: nameSpan });
      }
    });
    return rows;
  }

  function fmt(val) {
    if (val === null || val === undefined) return String(val);
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }

  function buildDetailRow(result) {
    const row = document.createElement('div');
    row.className = 'xc-audit-detail-row';
    let html = '';

    if (result.diffs.length) {
      html += `<div class="xc-audit-section xc-audit-section-fail">`;
      html += `<div class="xc-audit-section-header">Failed (${result.diffs.length})</div>`;
      for (const d of result.diffs) {
        html += `<div class="xc-audit-issue">`;
        html += `<div class="xc-audit-issue-path">${escapeHtml(d.path)}</div>`;
        if (d.type === 'MISSING') {
          html += `<div class="xc-audit-issue-detail">Configuration is <strong>missing</strong></div>`;
        } else {
          html += `<div class="xc-audit-issue-detail">Expected: <code>${escapeHtml(fmt(d.expected))}</code></div>`;
          html += `<div class="xc-audit-issue-detail">Found: <code>${escapeHtml(fmt(d.found))}</code></div>`;
        }
        if (d.explanation) {
          html += `<div class="xc-audit-reason">${escapeHtml(d.explanation.reason)}</div>`;
          if (d.explanation.next_step) {
            html += `<div class="xc-audit-fix">${escapeHtml(d.explanation.next_step)}</div>`;
          }
        }
        html += `</div>`;
      }
      html += `</div>`;
    }

    if (result.skipped?.length) {
      html += `<div class="xc-audit-section xc-audit-section-skip">`;
      html += `<div class="xc-audit-section-header">Skipped (${result.skipped.length})</div>`;
      for (const s of result.skipped) {
        html += `<span class="xc-audit-skipped-tag">${escapeHtml(s.label)} <code>${escapeHtml(s.labelKey)}=true</code></span>`;
      }
      html += `</div>`;
    }

    if (result.passed?.length) {
      html += `<div class="xc-audit-section xc-audit-section-pass">`;
      html += `<div class="xc-audit-section-header">Passed (${result.passed.length})</div>`;
      for (const p of result.passed) {
        html += `<span class="xc-audit-passed-tag">${escapeHtml(p.key)}</span>`;
      }
      html += `</div>`;
    }

    row.innerHTML = html;
    return row;
  }

  function injectBadges() {
    if (!auditResults?.loadBalancers?.length) return;

    const rows = findLbRows();
    for (const { wrapper, bodyRow, nameEl } of rows) {
      if (wrapper.querySelector('.xc-audit-badge')) continue;

      const lbName = nameEl.textContent?.trim();
      if (!lbName) continue;

      const result = auditResults.loadBalancers.find((lb) => lb.name === lbName);
      if (!result) continue;

      const skipCount = result.skipped?.length || 0;
      const passCount = result.passed?.length || 0;
      const failCount = result.diffs.length;
      const badge = document.createElement('span');
      badge.className = `xc-audit-badge ${result.pass ? 'xc-audit-pass' : 'xc-audit-fail'}`;

      const parts = [];
      if (passCount) parts.push(`${passCount} passed`);
      if (failCount) parts.push(`${failCount} failed`);
      if (skipCount) parts.push(`${skipCount} skipped`);
      badge.textContent = (result.pass ? 'PASS' : 'FAIL') + (parts.length ? ` (${parts.join(', ')})` : '');
      badge.title = 'Click to toggle details';

      const detailRow = buildDetailRow(result);
      detailRow.style.display = 'none';
      bodyRow.insertAdjacentElement('afterend', detailRow);
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        detailRow.style.display = detailRow.style.display === 'none' ? '' : 'none';
      });

      nameEl.insertAdjacentElement('afterend', badge);
    }
  }

  function showSessionBanner() {
    if (document.querySelector('.xc-audit-setup-banner')) return;

    const banner = document.createElement('div');
    banner.className = 'xc-audit-setup-banner';
    banner.textContent = 'F5 XC Audit: Session expired or not logged in. Please log in to the F5 XC console.';
    document.body.prepend(banner);
  }

  async function fetchPolicies(namespace) {
    const csrf = await getCsrf();
    if (!csrf) return { error: 'No CSRF token' };
    try {
      const apiPrefix = currentManagedTenant ? `/managed_tenant/${currentManagedTenant}` : '';
      const resp = await fetch(
        `${apiPrefix}/api/config/namespaces/${namespace}/active_service_policies?report_fields&csrf=${csrf}`
      );
      if (!resp.ok) return { error: `API ${resp.status}` };
      const policies = await resp.json();
      return { policies };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function registerLabels(labels) {
    const csrf = await getCsrf();
    if (!csrf) return { error: 'No CSRF token available. Navigate to the XC console first.' };

    const apiPrefix = currentManagedTenant ? `/managed_tenant/${currentManagedTenant}` : '';
    const post = async (path, body) => {
      const resp = await fetch(`${apiPrefix}${path}?csrf=${csrf}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      return { ok: resp.ok, status: resp.status, body: text };
    };

    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const results = [];

    for (const { key, value } of labels) {
      try {
        const keyResp = await post(
          '/api/config/namespaces/shared/known_label_key/create',
          { namespace: 'shared', key }
        );
        const keyOk = keyResp.ok || keyResp.body.includes('already exists') || keyResp.status === 409;
        if (!keyOk) {
          results.push({ key, value, status: 'error', detail: `key: ${keyResp.status}: ${keyResp.body.slice(0, 200)}` });
          await delay(1500);
          continue;
        }

        await delay(1500);

        const valResp = await post(
          '/api/config/namespaces/shared/known_label/create',
          { namespace: 'shared', key, value }
        );
        if (valResp.ok) {
          results.push({ key, value, status: 'created' });
        } else {
          const exists = valResp.body.includes('already exists') || valResp.status === 409;
          results.push({
            key, value,
            status: exists ? 'exists' : 'error',
            detail: exists ? undefined : `val: ${valResp.status}: ${valResp.body.slice(0, 200)}`,
          });
        }
      } catch (err) {
        results.push({ key, value, status: 'error', detail: err.message });
      }
      await delay(1500);
    }
    return { results };
  }

  function removeAllBadges() {
    document.querySelectorAll('.xc-audit-badge, .xc-audit-detail-row, .xc-audit-setup-banner').forEach((el) => el.remove());
    auditResults = null;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  init();
})();
