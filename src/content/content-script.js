(() => {
  let lastUrl = location.href;
  let auditResults = null;
  let debounceTimer = null;
  let currentManagedTenant = null;
  let planIncludes = {};
  let planLabels = {};
  let tierLabels = {};

  // --- Initialization ---

  function applyPlanMeta(meta) {
    if (!meta) return;
    tierLabels = meta.tierLabels || {};
    planLabels = meta.planLabels || {};
    for (const [id, includes] of Object.entries(meta.planIncludes || {})) {
      planIncludes[id] = includes;
    }
  }

  function init() {
    checkPage();

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'TRIGGER_REAUDIT') {
        removeAllBadges();
        chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, () => checkPage(true));
      }
      if (message.type === 'REGISTER_LABELS') {
        registerLabels(message.labels)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err.message }));
        return true;
      }
      if (message.type === 'DELETE_LABELS') {
        deleteLabels(message.labels)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err.message }));
        return true;
      }
      if (message.type === 'GET_POLICIES') {
        fetchPolicies(message.namespace)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err.message }));
        return true;
      }
      if (message.type === 'LIST_NAMESPACES') {
        listNamespaces(message.managedTenant)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err.message }));
        return true;
      }
      if (message.type === 'AUDIT_NAMESPACE') {
        if (message.managedTenant !== undefined) currentManagedTenant = message.managedTenant;
        auditNamespace(message.namespace)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err.message }));
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

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'session' || !changes.auditCache) return;
      const parsed = parseXcUrl(location.href);
      if (!parsed || !parsed.isLbListPage) return;
      const mt = parsed.managedTenant || currentManagedTenant;
      const cacheKey = mt
        ? `${parsed.tenant}/${mt}/${parsed.namespace}`
        : `${parsed.tenant}/${parsed.namespace}`;
      const entry = changes.auditCache.newValue?.[cacheKey];
      if (entry) {
        applyPlanMeta(entry.planMeta);
        const lbs = entry.loadBalancers || {};
        auditResults = {
          policies: entry.policies,
          loadBalancers: Object.values(lbs).map((e) => e.result),
        };
        observeAndInject();
      }
    });
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

  function currentTenant() {
    const parsed = parseXcUrl(location.href);
    return parsed ? { tenant: parsed.tenant, managedTenant: parsed.managedTenant || currentManagedTenant } : null;
  }

  async function auditNamespace(namespace) {
    const ctx = currentTenant();
    if (!ctx) throw new Error('Not on an XC console page');
    const { tenant, managedTenant } = ctx;

    const csrf = await getCsrf();
    if (!csrf) throw new Error('No CSRF token');

    const apiPrefix = managedTenant ? `/managed_tenant/${managedTenant}` : '';
    function apiUrl(path) {
      return `${apiPrefix}${path}?report_fields&csrf=${csrf}`;
    }

    let tenantMeta = await fetchTenantMeta(csrf, managedTenant);
    const domLogo = extractLogo();
    if (domLogo) tenantMeta = { ...tenantMeta, logoDataUrl: domLogo };
    if (managedTenant) tenantMeta = { ...tenantMeta, companyName: managedTenant };

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

    const lbConfigs = (
      await Promise.all(
        lbVersions.map((v) =>
          fetch(apiUrl(`/api/config/namespaces/${namespace}/http_loadbalancers/${v.name}`))
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        )
      )
    ).filter(Boolean);

    const referencedObjects = await fetchReferencedObjects(lbConfigs, namespace, apiUrl, policies, defaultPolicies);

    const baselineLbNames = new Set();
    for (const lb of lbConfigs) {
      const label = (lb.metadata?.labels || lb.labels || {})['xc-audit-baseline-lb'];
      if (label) baselineLbNames.add(label);
    }

    const baselineLbConfigs = {};
    let baselineLbReferencedObjects = { appFirewall: {}, servicePolicy: {} };
    if (baselineLbNames.size > 0) {
      await Promise.all([...baselineLbNames].map(async (name) => {
        try {
          const resp = await fetch(apiUrl(`/api/config/namespaces/default/http_loadbalancers/${name}`));
          if (resp.ok) baselineLbConfigs[name] = await resp.json();
        } catch {}
      }));
      const blbArray = Object.values(baselineLbConfigs);
      if (blbArray.length > 0) {
        baselineLbReferencedObjects = await fetchReferencedObjects(blbArray, 'default', apiUrl, defaultPolicies, null);
      }
    }

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'FORCE_RUN_AUDIT',
          tenant, namespace, managedTenant, policies, defaultPolicies, lbConfigs, lbVersions, referencedObjects,
          baselineLbConfigs, baselineLbReferencedObjects, tenantMeta,
        },
        (response) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(response);
        }
      );
    });
  }

  function clearLoading() {
    if (loadingObserver) { loadingObserver.disconnect(); loadingObserver = null; }
    document.querySelectorAll('.xc-audit-loading').forEach((el) => el.remove());
  }

  async function requestAudit(tenant, namespace, managedTenant, force) {
    try {
      currentManagedTenant = managedTenant;
      showLoadingBadges();

      const csrf = await getCsrf();
      if (!csrf) { clearLoading(); return; }

      const apiPrefix = managedTenant ? `/managed_tenant/${managedTenant}` : '';

      function apiUrl(path) {
        return `${apiPrefix}${path}?report_fields&csrf=${csrf}`;
      }

      let tenantMeta = await fetchTenantMeta(csrf, managedTenant);
      const domLogo = extractLogo();
      if (domLogo) tenantMeta = { ...tenantMeta, logoDataUrl: domLogo };
      if (managedTenant) tenantMeta = { ...tenantMeta, companyName: managedTenant };

      const [policies, defaultPolicies, lbListResp] = await Promise.all([
        fetch(apiUrl(`/api/config/namespaces/${namespace}/active_service_policies`))
          .then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(apiUrl(`/api/config/namespaces/default/active_service_policies`))
          .then((r) => (r.ok ? r.json() : null)).catch(() => null),
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
        if (check?.stale) {
          staleLbs = check.stale;
          freshResults = check.fresh || {};
        }
      }

      const lbConfigs = (
        await Promise.all(
          staleLbs.map((name) =>
            fetch(apiUrl(`/api/config/namespaces/${namespace}/http_loadbalancers/${name}`))
              .then((r) => (r.ok ? r.json() : null)).catch(() => null)
          )
        )
      ).filter(Boolean);

      const referencedObjects = await fetchReferencedObjects(lbConfigs, namespace, apiUrl, policies, defaultPolicies);

      const baselineLbNames = new Set();
      for (const lb of lbConfigs) {
        const label = (lb.metadata?.labels || lb.labels || {})['xc-audit-baseline-lb'];
        if (label) baselineLbNames.add(label);
      }

      const baselineLbConfigs = {};
      let baselineLbReferencedObjects = { appFirewall: {}, servicePolicy: {} };
      if (baselineLbNames.size > 0) {
        await Promise.all([...baselineLbNames].map(async (name) => {
          try {
            const resp = await fetch(apiUrl(`/api/config/namespaces/default/http_loadbalancers/${name}`));
            if (resp.ok) baselineLbConfigs[name] = await resp.json();
          } catch {}
        }));
        const blbArray = Object.values(baselineLbConfigs);
        if (blbArray.length > 0) {
          baselineLbReferencedObjects = await fetchReferencedObjects(blbArray, 'default', apiUrl, defaultPolicies, null);
        }
      }

      chrome.runtime.sendMessage(
        {
          type: force ? 'FORCE_RUN_AUDIT' : 'RUN_AUDIT',
          tenant, namespace, managedTenant, policies, defaultPolicies, lbConfigs, lbVersions, referencedObjects,
          baselineLbConfigs, baselineLbReferencedObjects, tenantMeta,
        },
        (response) => {
          if (chrome.runtime.lastError) { clearLoading(); return; }
          if (response?.type === 'AUDIT_RESULTS') {
            applyPlanMeta(response.planMeta);
            const data = response.data;
            for (const [name, result] of Object.entries(freshResults)) {
              if (!data.loadBalancers.find((lb) => lb.name === name)) {
                data.loadBalancers.push(result);
              }
            }
            auditResults = data;
            observeAndInject();
          } else {
            clearLoading();
          }
        }
      );
    } catch (err) {
      clearLoading();
      if (err.message?.includes('401') || err.message?.includes('403')) {
        showSessionBanner();
      }
    }
  }

  async function listNamespaces(managedTenant) {
    const mt = managedTenant !== undefined ? managedTenant : currentManagedTenant;
    const csrf = await getCsrf();
    if (!csrf) return { error: 'No CSRF token' };
    try {
      const apiPrefix = mt ? `/managed_tenant/${mt}` : '';
      const resp = await fetch(`${apiPrefix}/api/web/namespaces?csrf=${csrf}`);
      if (!resp.ok) return { error: `API ${resp.status}` };
      const data = await resp.json();
      const EXCLUDED_NS = new Set(['shared', 'system']);
      const namespaces = (data.items || []).map((ns) => ns.name).filter((n) => n && !EXCLUDED_NS.has(n));
      return { namespaces };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function fetchReferencedObjects(lbConfigs, namespace, apiUrl, policies, defaultPolicies) {
    const refs = { appFirewall: {}, servicePolicy: {} };
    const fwSeen = new Map();
    const spSeen = new Map();

    for (const lb of lbConfigs) {
      const fw = lb.spec?.app_firewall;
      if (fw?.name) {
        const ns = fw.namespace || namespace;
        const key = `${ns}/${fw.name}`;
        if (!fwSeen.has(key)) fwSeen.set(key, { name: fw.name, namespace: ns });
      }
    }

    const nsPolicies = policies?.service_policies || defaultPolicies?.service_policies || [];
    for (const sp of nsPolicies) {
      if (sp?.name) {
        const ns = sp.namespace || namespace;
        const key = `${ns}/${sp.name}`;
        if (!spSeen.has(key)) spSeen.set(key, { name: sp.name, namespace: ns });
      }
    }

    for (const lb of lbConfigs) {
      const lbPolicies = lb.spec?.active_service_policies?.policies || [];
      for (const sp of lbPolicies) {
        if (sp?.name) {
          const ns = sp.namespace || namespace;
          const key = `${ns}/${sp.name}`;
          if (!spSeen.has(key)) spSeen.set(key, { name: sp.name, namespace: ns });
        }
      }
    }

    const fetches = [];

    for (const [key, ref] of fwSeen) {
      fetches.push((async () => {
        try {
          const resp = await fetch(apiUrl(`/api/config/namespaces/${ref.namespace}/app_firewalls/${ref.name}`));
          if (resp.ok) {
            refs.appFirewall[key] = await resp.json();
            console.log('[XC Audit] Fetched app firewall policy:', key, refs.appFirewall[key]);
          }
        } catch {}
      })());
    }

    for (const [key, ref] of spSeen) {
      fetches.push((async () => {
        try {
          const resp = await fetch(apiUrl(`/api/config/namespaces/${ref.namespace}/service_policys/${ref.name}`));
          if (resp.ok) {
            refs.servicePolicy[key] = await resp.json();
            console.log('[XC Audit] Fetched service policy:', key, refs.servicePolicy[key]);
          }
        } catch {}
      })());
    }

    await Promise.all(fetches);
    return refs;
  }

  let loadingObserver = null;

  function showLoadingBadges() {
    injectLoadingBadgesOnce();

    if (loadingObserver) loadingObserver.disconnect();
    const contentArea = document.querySelector('[class*="content"]') || document.body;
    let loadingDebounce = null;
    loadingObserver = new MutationObserver(() => {
      if (loadingDebounce) clearTimeout(loadingDebounce);
      loadingDebounce = setTimeout(injectLoadingBadgesOnce, 150);
    });
    loadingObserver.observe(contentArea, { childList: true, subtree: true });
  }

  function injectLoadingBadgesOnce() {
    if (auditResults) return;
    const rows = findLbRows();
    for (const { wrapper, nameEl } of rows) {
      if (wrapper.querySelector('.xc-audit-badge') || wrapper.querySelector('.xc-audit-loading')) continue;
      const badge = document.createElement('span');
      badge.className = 'xc-audit-badge xc-audit-loading';
      badge.textContent = '⏳ Auditing...';
      nameEl.insertAdjacentElement('afterend', badge);
    }
  }

  let badgeObserver = null;
  let retryTimer = null;

  function observeAndInject() {
    if (loadingObserver) { loadingObserver.disconnect(); loadingObserver = null; }
    if (badgeObserver) { badgeObserver.disconnect(); badgeObserver = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    document.querySelectorAll('.xc-audit-loading').forEach((el) => el.remove());
    injectBadges();

    badgeObserver = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(injectBadges, 200);
    });
    badgeObserver.observe(document.body, { childList: true, subtree: true });

    let retries = 0;
    function retryInject() {
      if (!auditResults?.loadBalancers?.length) return;
      const rows = findLbRows();
      const injected = rows.some((r) => r.wrapper.querySelector('.xc-audit-badge:not(.xc-audit-loading)'));
      if (!injected && retries < 15) {
        retries++;
        injectBadges();
        retryTimer = setTimeout(retryInject, 500);
      }
    }
    retryTimer = setTimeout(retryInject, 300);
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

  function resolveCheck(checks, path) {
    const topKey = path.split('.')[1];
    return checks?.find((c) => c.key === topKey) || null;
  }

  function isActiveForPlan(checkPlan, currentPlan, addons, checkKey) {
    return (planIncludes[currentPlan] || ['essentials']).includes(checkPlan) || addons?.includes(checkKey);
  }

  function planTagLabel(checkPlan) {
    return tierLabels[checkPlan] || planLabels[checkPlan] || null;
  }

  function buildDiffHtml(d, checks, planCtx) {
    const check = resolveCheck(checks, d.path);
    const displayName = check?.label || d.path;
    const tooltip = check?.description || '';
    const isOptional = d.required === false;
    const active = isActiveForPlan(d.plan || check?.plan || 'essentials', planCtx?.plan, planCtx?.addons, check?.key);
    if (!active) {
      const tag = planTagLabel(d.plan || check?.plan);
      return `<div class="xc-audit-issue xc-audit-unavailable"><span class="xc-audit-plan-tag">${tag}</span><div class="xc-audit-issue-path"${tooltip ? ` data-tooltip="${escapeHtml(tooltip)}"` : ''}>${escapeHtml(displayName)}</div></div>`;
    }
    let html = `<div class="xc-audit-issue${isOptional ? ' xc-audit-issue-optional' : ''}">`;
    if (isOptional) {
      html += `<span class="xc-audit-recommended-tag">Recommended</span>`;
    }
    html += `<div class="xc-audit-issue-path"${tooltip ? ` data-tooltip="${escapeHtml(tooltip)}"` : ''}>${escapeHtml(displayName)}</div>`;
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
    return html;
  }

  function buildDetailRow(result) {
    const row = document.createElement('div');
    row.className = 'xc-audit-detail-row';
    let html = '';

    const currentPlan = result.plan || 'essentials';
    const planCtx = { plan: currentPlan, addons: result.addons || [] };
    if (result.categorized?.length) {
      for (const cat of result.categorized) {
        html += `<div class="xc-audit-category">`;
        html += `<div class="xc-audit-category-header">${escapeHtml(cat.label)}</div>`;

        if (cat.warnings.length) {
          for (const d of cat.warnings) {
            html += buildDiffHtml(d, cat.checks, planCtx);
          }
        }

        if (cat.inspections?.length) {
          for (const insp of cat.inspections) {
            const inspCheck = cat.checks?.find((c) => c.inspector === insp.inspector);
            const inspLabel = inspCheck?.label || insp.refName;
            const inspTooltip = inspCheck?.description || '';
            const active = isActiveForPlan(insp.plan || inspCheck?.plan || 'essentials', currentPlan, planCtx.addons, inspCheck?.key);
            if (!active) {
              const tag = planTagLabel(insp.plan || inspCheck?.plan);
              html += `<span class="xc-audit-unavailable-tag" data-tooltip="${escapeHtml(inspTooltip)}">${escapeHtml(inspLabel)} — ${tag}</span>`;
            } else if (insp.pass) {
              html += `<span class="xc-audit-passed-tag"${inspTooltip ? ` data-tooltip="${escapeHtml(inspTooltip)}"` : ''}>${escapeHtml(inspLabel)}</span>`;
            } else {
              html += `<div class="xc-audit-inspection">`;
              html += `<div class="xc-audit-inspection-header"${inspTooltip ? ` data-tooltip="${escapeHtml(inspTooltip)}"` : ''}>${escapeHtml(inspLabel)} (${insp.diffs.length} issue${insp.diffs.length === 1 ? '' : 's'})</div>`;
              for (const d of insp.diffs) {
                const detail = d.explanation?.reason || (d.type === 'MISSING' ? 'Configuration is missing' :
                  `Expected: ${fmt(d.expected)}, Found: ${fmt(d.found)}`);
                html += `<div class="xc-audit-issue"><div class="xc-audit-issue-detail">${escapeHtml(detail)}</div>`;
                if (d.explanation?.next_step) html += `<div class="xc-audit-fix">${escapeHtml(d.explanation.next_step)}</div>`;
                html += `</div>`;
              }
              html += `</div>`;
            }
          }
        }

        if (cat.overrides?.length) {
          for (const o of cat.overrides) {
            const check = o.inspector
              ? cat.checks?.find((c) => c.inspector === o.inspector)
              : cat.checks?.find((c) => c.key === o.path?.split('.')[1]);
            const label = check?.label || o.path || o.inspector;
            const tooltip = check?.description || '';
            const active = isActiveForPlan(o.plan || check?.plan || 'essentials', currentPlan, planCtx.addons, check?.key);
            if (!active) {
              const tag = planTagLabel(o.plan || check?.plan);
              html += `<span class="xc-audit-unavailable-tag"${tooltip ? ` data-tooltip="${escapeHtml(tooltip)}"` : ''}>${escapeHtml(label)} — ${tag}</span>`;
            } else if (o.overrideStatus === 'not_in_baseline') {
              html += `<span class="xc-audit-info-tag"${tooltip ? ` data-tooltip="${escapeHtml(tooltip)}"` : ''}>${escapeHtml(label)} — not in baseline</span>`;
            } else {
              html += `<span class="xc-audit-passed-tag"${tooltip ? ` data-tooltip="${escapeHtml(tooltip)}"` : ''}>${escapeHtml(label)} — via ${escapeHtml(result.baselineLb)}</span>`;
            }
          }
        }

        if (cat.skipped.length) {
          for (const s of cat.skipped) {
            const check = cat.checks?.find((c) => c.key === s.key);
            const label = check?.label || s.label;
            const tooltip = check?.description || '';
            html += `<span class="xc-audit-skipped-tag"${tooltip ? ` data-tooltip="${escapeHtml(tooltip)}"` : ''}>${escapeHtml(label)} — Ignored by Label</span>`;
          }
        }

        if (cat.passed.length) {
          for (const p of cat.passed) {
            const check = cat.checks?.find((c) => c.key === p.key);
            const label = check?.label || p.key;
            const tooltip = check?.description || '';
            const active = isActiveForPlan(p.plan || check?.plan || 'essentials', currentPlan, planCtx.addons, check?.key);
            if (!active) {
              const tag = planTagLabel(p.plan || check?.plan);
              html += `<span class="xc-audit-unavailable-tag" data-tooltip="${escapeHtml(tooltip)}">${escapeHtml(label)} — ${tag}</span>`;
            } else {
              html += `<span class="xc-audit-passed-tag"${tooltip ? ` data-tooltip="${escapeHtml(tooltip)}"` : ''}>${escapeHtml(label)}</span>`;
            }
          }
        }

        if (cat.id === 'policy' && result.policyComparison) {
          const cmp = result.policyComparison;
          if (cmp.match) {
            html += `<span class="xc-audit-passed-tag">Active service policies match ${escapeHtml(cmp.baselineSource)}</span>`;
          } else {
            html += `<span class="xc-audit-info-tag">Active service policies differ from ${escapeHtml(cmp.baselineSource)}</span>`;
          }
        }

        html += `</div>`;
      }
    } else {
      if (result.diffs.length) {
        html += `<div class="xc-audit-section xc-audit-section-warning">`;
        html += `<div class="xc-audit-section-header">Warnings (${result.diffs.length})</div>`;
        for (const d of result.diffs) { html += buildDiffHtml(d); }
        html += `</div>`;
      }
      if (result.skipped?.length) {
        html += `<div class="xc-audit-section xc-audit-section-skip">`;
        html += `<div class="xc-audit-section-header">Skipped (${result.skipped.length})</div>`;
        for (const s of result.skipped) {
          html += `<span class="xc-audit-skipped-tag">${escapeHtml(s.label)} — Ignored by Label</span>`;
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

      const plan = result.plan || 'essentials';
      const addons = result.addons || [];
      const activeDiffs = result.diffs.filter((d) => isActiveForPlan(d.plan || 'essentials', plan, addons, d.key));
      const activeInspections = (result.inspections || []).filter((i) => isActiveForPlan(i.plan || 'essentials', plan, addons, i.key));
      const activePassed = (result.passed || []).filter((p) => isActiveForPlan(p.plan || 'essentials', plan, addons, p.key));
      const skipCount = result.skipped?.length || 0;
      const notInBaselineCount = (result.baselineOverrides || []).filter((o) => o.overrideStatus === 'not_in_baseline').length;
      const passCount = activePassed.length;
      const recommendedCount = activeDiffs.filter((d) => d.required === false).length;
      const requiredWarningCount = activeDiffs.filter((d) => d.required !== false).length +
        activeInspections.filter((i) => !i.pass).length;
      const badge = document.createElement('span');
      badge.className = `xc-audit-badge ${result.pass ? 'xc-audit-pass' : 'xc-audit-warning'}`;

      const parts = [];
      if (passCount) parts.push(`${passCount} passed`);
      if (requiredWarningCount) parts.push(`${requiredWarningCount} warnings`);
      if (recommendedCount) parts.push(`${recommendedCount} recommended`);
      if (notInBaselineCount) parts.push(`${notInBaselineCount} not in baseline`);
      if (skipCount) parts.push(`${skipCount} skipped`);
      badge.textContent = (result.pass ? '✅' : '⚠️') + (parts.length ? ` (${parts.join(', ')})` : '');
      badge.title = 'Click to toggle details';

      const detailRow = buildDetailRow(result);
      detailRow.style.display = 'none';
      bodyRow.insertAdjacentElement('afterend', detailRow);
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        detailRow.style.display = detailRow.style.display === 'none' ? '' : 'none';
      });

      nameEl.insertAdjacentElement('afterend', badge);
      if (result.baselineLb) {
        const refTag = document.createElement('span');
        refTag.className = 'xc-audit-info-tag';
        refTag.style.marginLeft = '4px';
        refTag.textContent = `ref: ${result.baselineLb}`;
        refTag.title = `Audit overridden by baseline LB "${result.baselineLb}" in default namespace`;
        badge.insertAdjacentElement('afterend', refTag);
      }
    }
  }

  function showSessionBanner() {
    if (document.querySelector('.xc-audit-setup-banner')) return;

    const banner = document.createElement('div');
    banner.className = 'xc-audit-setup-banner';
    banner.textContent = 'F5 XC Audit: Session expired or not logged in. Please log in to the F5 XC console.';
    document.body.prepend(banner);
  }

  function extractLogo() {
    const customLogo = document.querySelector('img[ves-e2e-test="logo-custom-img"]');
    if (customLogo?.src?.startsWith('data:image')) return customLogo.src;
    const imgs = document.querySelectorAll('img[src^="data:image"]');
    for (const img of imgs) {
      if (img.closest('[class*="sidebar"], [class*="header"], [class*="nav"], [class*="logo"], [class*="brand"]')) {
        return img.src;
      }
    }
    return imgs.length ? imgs[0].src : null;
  }

  async function fetchTenantMeta(csrf, managedTenant) {
    const apiPrefix = managedTenant ? `/managed_tenant/${managedTenant}` : '';
    const tenantChecks = {
      sso: { status: 'unknown', detail: 'Unable to verify' },
      mfa: { status: 'unknown', detail: 'Unable to verify' },
      passwordPolicy: { status: 'unknown', detail: 'Unable to verify' },
      globalLogReceiver: { status: 'unknown', detail: 'Unable to verify' },
    };
    let companyName = null;

    try {
      const resp = await fetch(`${apiPrefix}/api/web/namespaces/system/tenant/settings?csrf=${csrf}`);
      if (resp.ok) {
        const data = await resp.json();
        console.log('[XC Audit] Tenant settings response:', JSON.stringify(data).slice(0, 3000));
        companyName = managedTenant || data.company_name || null;

        const ssoConfig = data.sso_config || data.login_options?.sso_config;
        if (ssoConfig && Object.keys(ssoConfig).length > 0) {
          tenantChecks.sso = { status: 'pass', detail: 'SSO configured' };
        } else {
          tenantChecks.sso = { status: 'fail', detail: 'SSO not configured' };
        }

        const mfaEnforced = data.mfa_required || data.login_options?.mfa_required
          || data.two_factor_auth?.enforced;
        if (mfaEnforced) {
          tenantChecks.mfa = { status: 'pass', detail: 'MFA enforced' };
        } else {
          tenantChecks.mfa = { status: 'fail', detail: 'MFA not enforced' };
        }
      }
    } catch { /* leave as unknown */ }

    try {
      const resp = await fetch(`${apiPrefix}/api/web/namespaces/system/tenant/idm/settings?csrf=${csrf}`);
      if (resp.ok) {
        const data = await resp.json();
        console.log('[XC Audit] Tenant IDM settings response:', JSON.stringify(data).slice(0, 3000));
        if (!managedTenant) {
          companyName = data.tenant_details?.display_name || companyName;
        }

        const pwPolicy = data.password_policy;
        if (pwPolicy && Object.keys(pwPolicy).length > 0) {
          tenantChecks.passwordPolicy = { status: 'pass', detail: 'Custom password policy configured' };
        } else {
          tenantChecks.passwordPolicy = { status: 'fail', detail: 'No custom password policy' };
        }
      }
    } catch { /* leave as unknown */ }

    try {
      const resp = await fetch(
        `${apiPrefix}/api/config/namespaces/system/global_log_receivers?report_fields&csrf=${csrf}`
      );
      if (resp.ok) {
        const data = await resp.json();
        console.log('[XC Audit] Global log receivers response:', JSON.stringify(data).slice(0, 3000));
        const items = data.items || [];
        if (items.length > 0) {
          tenantChecks.globalLogReceiver = {
            status: 'pass',
            detail: `${items.length} global log receiver${items.length === 1 ? '' : 's'} configured`,
          };
        } else {
          tenantChecks.globalLogReceiver = { status: 'fail', detail: 'No global log receivers configured' };
        }
      }
    } catch { /* leave as unknown */ }

    return { companyName, logoDataUrl: extractLogo(), tenantChecks };
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
    const api = async (method, path, body) => {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const resp = await fetch(`${apiPrefix}${path}?csrf=${csrf}`, opts);
      const text = await resp.text();
      return { ok: resp.ok, status: resp.status, body: text };
    };

    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const results = [];

    for (const { key, value, description } of labels) {
      try {
        const keyResp = await api('POST',
          '/api/config/namespaces/shared/known_label_key/create',
          { namespace: 'shared', key, description }
        );
        const keyExists = keyResp.body.includes('already exists') || keyResp.status === 409;
        const keyOk = keyResp.ok || keyExists;
        if (!keyOk) {
          results.push({ key, value, status: 'error', detail: `key: ${keyResp.status}: ${keyResp.body.slice(0, 200)}` });
          await delay(1500);
          continue;
        }

        if (keyExists && description) {
          await delay(1500);
          const getResp = await api('GET', `/api/config/namespaces/shared/known_label_key/${key}`);
          if (getResp.ok) {
            try {
              const existing = JSON.parse(getResp.body);
              if (!existing.description && !existing.spec?.description) {
                await delay(1500);
                await api('PUT', `/api/config/namespaces/shared/known_label_key/${key}`,
                  { namespace: 'shared', key, description }
                );
              }
            } catch {}
          }
        }

        await delay(1500);

        const valResp = await api('POST',
          '/api/config/namespaces/shared/known_label/create',
          { namespace: 'shared', key, value, description }
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

  async function deleteLabels(labels) {
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
        const valResp = await post(
          '/api/config/namespaces/shared/known_label/delete',
          { namespace: 'shared', key, value }
        );
        await delay(1500);

        const keyResp = await post(
          '/api/config/namespaces/shared/known_label_key/delete',
          { namespace: 'shared', key }
        );

        if (valResp.ok || keyResp.ok) {
          results.push({ key, value, status: 'deleted' });
        } else {
          const notFound = (valResp.status === 404 || valResp.body.includes('not found')) &&
            (keyResp.status === 404 || keyResp.body.includes('not found'));
          results.push({
            key, value,
            status: notFound ? 'not_found' : 'error',
            detail: notFound ? undefined : `${keyResp.status}: ${keyResp.body.slice(0, 200)}`,
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
    if (loadingObserver) { loadingObserver.disconnect(); loadingObserver = null; }
    if (badgeObserver) { badgeObserver.disconnect(); badgeObserver = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
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
