(() => {
  let lastUrl = location.href;
  let auditResults = null;
  let debounceTimer = null;

  // --- Initialization ---

  function init() {
    checkPage();

    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'TRIGGER_REAUDIT') {
        removeAllBadges();
        chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, () => checkPage(true));
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
    requestAudit(parsed.tenant, parsed.namespace, force);
  }

  async function getCsrf(retries = 10) {
    for (let i = 0; i < retries; i++) {
      const { csrf } = await chrome.runtime.sendMessage({ type: 'GET_CSRF' });
      if (csrf) return csrf;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  async function requestAudit(tenant, namespace, force) {
    try {
      const csrf = await getCsrf();
      if (!csrf) return;

      function apiUrl(path) {
        return `${path}?report_fields&csrf=${csrf}`;
      }

      const [policies, lbListResp] = await Promise.all([
        fetch(apiUrl(`/api/config/namespaces/${namespace}/active_service_policies`))
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch(apiUrl(`/api/config/namespaces/${namespace}/http_loadbalancers`)),
      ]);

      if (!lbListResp.ok) throw new Error(`API ${lbListResp.status}`);
      const lbList = (await lbListResp.json()).items || [];

      const lbConfigs = (
        await Promise.all(
          lbList.map((lb) =>
            fetch(apiUrl(`/api/config/namespaces/${namespace}/http_loadbalancers/${lb.name}`))
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          )
        )
      ).filter(Boolean);

      chrome.runtime.sendMessage(
        { type: force ? 'FORCE_RUN_AUDIT' : 'RUN_AUDIT', tenant, namespace, policies, lbConfigs },
        (response) => {
          if (chrome.runtime.lastError) return;
          if (response?.type === 'AUDIT_RESULTS') {
            auditResults = response.data;
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

    let html = `<div class="xc-audit-detail-header">${result.diffs.length} issue(s)</div>`;
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

      const badge = document.createElement('span');
      badge.className = `xc-audit-badge ${result.pass ? 'xc-audit-pass' : 'xc-audit-fail'}`;
      badge.textContent = result.pass
        ? 'PASS'
        : `FAIL (${result.diffs.length})`;

      if (result.pass) {
        badge.title = 'All baseline checks passed';
      } else {
        badge.title = 'Click to toggle details';
        const detailRow = buildDetailRow(result);
        detailRow.style.display = 'none';
        bodyRow.insertAdjacentElement('afterend', detailRow);
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          detailRow.style.display = detailRow.style.display === 'none' ? '' : 'none';
        });
      }

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
