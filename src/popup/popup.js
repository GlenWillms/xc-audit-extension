const XC_URL_PATTERN =
  /^https:\/\/([^.]+)\.console\.ves\.volterra\.io\/(?:managed_tenant\/([^/]+)\/)?web\/workspaces\/([^/]+)\/(.+)/;
const NAMESPACE_SEGMENT = /namespaces\/([^/]+)/;
const LB_LIST_PATH = /manage\/load[_-]?balancers\/http[_-]?load[_-]?balancers\/?$/i;

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

  const statusIcon = document.getElementById('statusIcon');
  const statusText = document.getElementById('statusText');
  const resultsEl = document.getElementById('results');
  const policyResult = document.getElementById('policyResult');
  const lbSummary = document.getElementById('lbSummary');
  const notOnPage = document.getElementById('notOnPage');

  document.getElementById('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const match = url.match(XC_URL_PATTERN);

  if (!match || !LB_LIST_PATH.test(match[4])) {
    statusIcon.className = 'icon gray';
    statusText.textContent = 'Not on LB list page';
    notOnPage.style.display = 'block';
    return;
  }

  const nsMatch = match[4].match(NAMESPACE_SEGMENT);
  const tenant = match[1];
  const managedTenant = match[2] || null;
  const namespace = nsMatch ? nsMatch[1] : match[3];

  if (managedTenant) {
    const header = document.querySelector('.header');
    const versionSpan = document.getElementById('version');
    header.firstChild.textContent = `F5 XC Audit — ${managedTenant} `;
    header.appendChild(versionSpan);
  }

  statusText.textContent = 'Loading...';
  statusIcon.className = 'icon gray';

  document.getElementById('reAudit').addEventListener('click', () => {
    statusText.textContent = 'Re-auditing...';
    statusIcon.className = 'icon gray';
    resultsEl.style.display = 'none';
    chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_REAUDIT' }).catch(() => {});
  });

  const { auditCache } = await chrome.storage.session.get('auditCache');
  function cacheToResults(entry) {
    if (!entry) return null;
    if (entry.results) return entry.results;
    return {
      policies: entry.policies || null,
      loadBalancers: Object.values(entry.loadBalancers || {}).map((e) => e.result),
    };
  }

  const cacheKey = managedTenant ? `${tenant}/${managedTenant}/${namespace}` : `${tenant}/${namespace}`;
  const cached = auditCache?.[cacheKey];

  if (cached) {
    renderResults(cacheToResults(cached));
  } else {
    statusIcon.className = 'icon gray';
    statusText.textContent = 'Audit in progress...';

    chrome.storage.session.onChanged.addListener((changes) => {
      if (!changes.auditCache) return;
      const entry = changes.auditCache.newValue?.[cacheKey];
      if (entry) renderResults(cacheToResults(entry));
    });
  }

  function fmt(val) {
    if (val === null || val === undefined) return String(val);
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }

  async function renderResults(data) {
    const warningCount = data.loadBalancers.filter((lb) => !lb.pass).length;
    const passCount = data.loadBalancers.length - warningCount;

    if (warningCount === 0) {
      statusIcon.className = 'icon green';
      statusText.textContent = 'All checks passed';
    } else {
      statusIcon.className = 'icon red';
      statusText.textContent = `${warningCount} issue(s) found`;
    }

    resultsEl.style.display = 'block';
    lbSummary.textContent = `Load Balancers: ${passCount} pass, ${warningCount} warning (${data.loadBalancers.length} total)`;
    lbSummary.className = `result-item ${warningCount > 0 ? 'result-warning' : 'result-pass'}`;

    if (data.policies) {
      policyResult.style.display = 'block';
      policyResult.innerHTML = '';
      const policyDetail = document.createElement('details');
      policyDetail.className = `lb-detail ${data.policies.pass ? 'lb-pass' : 'lb-warning'}`;
      const policySummary = document.createElement('summary');
      policySummary.textContent = `Service Policies: ${data.policies.pass ? '✅' : '⚠️'}`;
      if (!data.policies.pass) policySummary.textContent += ` (${data.policies.diffs.length})`;
      policyDetail.appendChild(policySummary);

      if (!data.policies.pass && data.policies.diffs) {
        const list = document.createElement('ul');
        list.className = 'diff-list';
        for (const d of data.policies.diffs) {
          const li = document.createElement('li');
          li.className = 'diff-item';
          let text = d.path;
          if (d.type === 'MISSING') {
            text += ' — missing';
          } else {
            text += ` — expected: ${fmt(d.expected)}, found: ${fmt(d.found)}`;
          }
          li.textContent = text;
          if (d.explanation) {
            const reason = document.createElement('div');
            reason.className = 'diff-reason';
            reason.textContent = d.explanation.reason;
            li.appendChild(reason);
          }
          list.appendChild(li);
        }
        policyDetail.appendChild(list);
      }

      const btnRow = document.createElement('div');
      btnRow.className = 'policy-btn-row';

      const setBaselineBtn = document.createElement('button');
      setBaselineBtn.className = 'btn btn-sm btn-set-baseline';
      setBaselineBtn.textContent = `Use ${namespace}'s policies as baseline`;
      setBaselineBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        setBaselineBtn.disabled = true;
        setBaselineBtn.textContent = 'Saving...';
        try {
          const resp = await chrome.tabs.sendMessage(tab.id, {
            type: 'GET_POLICIES', namespace,
          });
          if (resp?.policies) {
            await chrome.runtime.sendMessage({
              type: 'SAVE_POLICY_OVERRIDE',
              tenant,
              namespace,
              policies: resp.policies,
            });
            await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
            setBaselineBtn.textContent = `Override saved for ${namespace} — re-audit`;
            setBaselineBtn.className = 'btn btn-sm btn-set-baseline-done';
          } else {
            setBaselineBtn.textContent = resp?.error || 'Failed to fetch policies';
          }
        } catch {
          setBaselineBtn.textContent = 'Error — is the XC page open?';
        }
      });
      btnRow.appendChild(setBaselineBtn);

      const poKey = `tenant:${tenant}:policyOverrides`;
      const poData = await chrome.storage.local.get([poKey, 'policyOverrides']);
      const policyOverrides = poData[poKey] ?? poData.policyOverrides;
      if (policyOverrides?.[namespace]) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'btn btn-sm btn-secondary';
        clearBtn.textContent = 'Clear override (use default)';
        clearBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await chrome.runtime.sendMessage({ type: 'CLEAR_POLICY_OVERRIDE', tenant, namespace });
          await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
          clearBtn.textContent = 'Cleared — re-audit';
          clearBtn.disabled = true;
        });
        btnRow.appendChild(clearBtn);

        const overrideNote = document.createElement('div');
        overrideNote.className = 'policy-override-note';
        overrideNote.textContent = `Using override for ${namespace} (not default namespace)`;
        policyDetail.appendChild(overrideNote);
      }

      policyDetail.appendChild(btnRow);

      policyResult.appendChild(policyDetail);
    }

    const detailsEl = document.getElementById('lbDetails');
    detailsEl.innerHTML = '';
    for (const lb of data.loadBalancers) {
      const lbEl = document.createElement('details');
      lbEl.className = `lb-detail ${lb.pass ? 'lb-pass' : 'lb-warning'}`;

      const plan = lb.plan || 'essentials';
      const addons = new Set(lb.addons || []);
      const isActive = (checkPlan, checkKey) => {
        if (checkPlan === 'essentials') return true;
        if (checkPlan === 'enterprise') return plan === 'enterprise';
        if (checkPlan === 'addon') return plan === 'enterprise' || addons.has(checkKey);
        return false;
      };
      const activeDiffs = lb.diffs.filter((d) => isActive(d.plan || 'essentials', d.key));
      const activeInspections = (lb.inspections || []).filter((i) => isActive(i.plan || 'essentials', i.key));
      const activePassed = (lb.passed || []).filter((p) => isActive(p.plan || 'essentials', p.key));
      const skipCount = lb.skipped?.length || 0;
      const passCount = activePassed.length;
      const recommendedCount = activeDiffs.filter((d) => d.required === false).length;
      const requiredWarningCount = activeDiffs.filter((d) => d.required !== false).length +
        activeInspections.filter((i) => !i.pass).length;
      const summary = document.createElement('summary');
      const parts = [];
      if (passCount) parts.push(`${passCount} passed`);
      if (requiredWarningCount) parts.push(`${requiredWarningCount} warnings`);
      if (recommendedCount) parts.push(`${recommendedCount} recommended`);
      if (skipCount) parts.push(`${skipCount} skipped`);
      const refNote = lb.baselineLb ? ` [ref: ${lb.baselineLb}]` : '';
      summary.textContent = `${lb.pass ? '✅' : '⚠️'} ${lb.name}${refNote} (${parts.join(', ')})`;
      lbEl.appendChild(summary);

      if (lb.categorized?.length) {
        for (const cat of lb.categorized) {
          const catSection = document.createElement('div');
          catSection.className = 'popup-category';

          const catHeader = document.createElement('div');
          catHeader.className = 'popup-category-header';
          catHeader.textContent = cat.label;
          catSection.appendChild(catHeader);

          const list = document.createElement('ul');
          list.className = 'diff-list';

          for (const d of cat.warnings) {
            const check = cat.checks?.find((c) => d.path.split('.')[1] === c.key);
            const displayName = check?.label || d.path;
            const isOptional = d.required === false;
            const active = isActive(d.plan || check?.plan || 'essentials', check?.key);
            const li = document.createElement('li');
            if (!active) {
              const tag = (d.plan || check?.plan) === 'addon' ? 'Add-on' : 'Enterprise';
              li.className = 'diff-item diff-unavailable';
              if (check?.description) li.dataset.tooltip = check.description;
              li.textContent = `${displayName} — ${tag}`;
            } else {
              li.className = `diff-item ${isOptional ? 'diff-recommended' : 'diff-warning'}`;
              if (check?.description) li.dataset.tooltip = check.description;
              let text = isOptional ? `${displayName} — recommended` : displayName;
              if (d.type === 'MISSING') {
                text += isOptional ? '' : ' — missing';
              } else {
                text += ` — expected: ${fmt(d.expected)}, found: ${fmt(d.found)}`;
              }
              li.textContent = text;
              if (d.explanation) {
                const reason = document.createElement('div');
                reason.className = 'diff-reason';
                reason.textContent = d.explanation.reason;
                li.appendChild(reason);
              }
            }
            list.appendChild(li);
          }

          for (const insp of cat.inspections || []) {
            const inspCheck = cat.checks?.find((c) => c.inspector === insp.inspector);
            const inspLabel = inspCheck?.label || insp.refName;
            const active = isActive(insp.plan || inspCheck?.plan || 'essentials', inspCheck?.key);
            if (!active) {
              const tag = (insp.plan || inspCheck?.plan) === 'addon' ? 'Add-on' : 'Enterprise';
              const li = document.createElement('li');
              li.className = 'diff-item diff-unavailable';
              if (inspCheck?.description) li.dataset.tooltip = inspCheck.description;
              li.textContent = `${inspLabel} — ${tag}`;
              list.appendChild(li);
            } else if (insp.pass) {
              const li = document.createElement('li');
              li.className = 'diff-item diff-pass';
              if (inspCheck?.description) li.dataset.tooltip = inspCheck.description;
              li.textContent = inspLabel;
              list.appendChild(li);
            } else {
              for (const d of insp.diffs) {
                const li = document.createElement('li');
                li.className = 'diff-item diff-warning';
                if (inspCheck?.description) li.dataset.tooltip = inspCheck.description;
                li.textContent = inspLabel;
                if (d.type !== 'MISSING') {
                  li.textContent += ` — expected: ${fmt(d.expected)}, found: ${fmt(d.found)}`;
                } else {
                  li.textContent += ' — missing';
                }
                if (d.explanation) {
                  const reason = document.createElement('div');
                  reason.className = 'diff-reason';
                  reason.textContent = d.explanation.reason;
                  li.appendChild(reason);
                }
                list.appendChild(li);
              }
            }
          }

          for (const o of (cat.overrides || [])) {
            const check = o.inspector
              ? cat.checks?.find((c) => c.inspector === o.inspector)
              : cat.checks?.find((c) => c.key === o.path?.split('.')[1]);
            const label = check?.label || o.path || o.inspector;
            const active = isActive(o.plan || check?.plan || 'essentials', check?.key);
            const li = document.createElement('li');
            if (!active) {
              const tag = (o.plan || check?.plan) === 'addon' ? 'Add-on' : 'Enterprise';
              li.className = 'diff-item diff-unavailable';
              if (check?.description) li.dataset.tooltip = check.description;
              li.textContent = `${label} — ${tag}`;
            } else {
              li.className = 'diff-item diff-pass';
              if (check?.description) li.dataset.tooltip = check.description;
              li.textContent = `${label} — via ${lb.baselineLb}`;
            }
            list.appendChild(li);
          }

          if (cat.skipped.length) {
            for (const s of cat.skipped) {
              const check = cat.checks?.find((c) => c.key === s.key);
              const label = check?.label || s.label;
              const li = document.createElement('li');
              li.className = 'diff-item diff-skip';
              if (check?.description) li.dataset.tooltip = check.description;
              li.textContent = `${label} — Ignored by Label`;
              list.appendChild(li);
            }
          }

          if (cat.passed.length) {
            for (const p of cat.passed) {
              const check = cat.checks?.find((c) => c.key === p.key);
              const active = isActive(p.plan || check?.plan || 'essentials', check?.key);
              const li = document.createElement('li');
              if (!active) {
                const tag = (p.plan || check?.plan) === 'addon' ? 'Add-on' : 'Enterprise';
                li.className = 'diff-item diff-unavailable';
                if (check?.description) li.dataset.tooltip = check.description;
                li.textContent = `${check?.label || p.key} — ${tag}`;
              } else {
                li.className = 'diff-item diff-pass';
                if (check?.description) li.dataset.tooltip = check.description;
                li.textContent = check?.label || p.key;
              }
              list.appendChild(li);
            }
          }

          if (cat.id === 'policy' && lb.policyComparison) {
            const cmp = lb.policyComparison;
            const li = document.createElement('li');
            if (cmp.match) {
              li.className = 'diff-item diff-pass';
              li.textContent = `Active service policies match ${cmp.baselineSource}`;
            } else {
              li.className = 'diff-item diff-info';
              li.textContent = `Active service policies differ from ${cmp.baselineSource}`;
            }
            list.appendChild(li);
          }

          catSection.appendChild(list);
          lbEl.appendChild(catSection);
        }
      } else {
        const list = document.createElement('ul');
        list.className = 'diff-list';
        for (const d of lb.diffs) {
          const li = document.createElement('li');
          li.className = 'diff-item diff-warning';
          let text = d.path;
          if (d.type === 'MISSING') {
            text += ' — missing';
          } else {
            text += ` — expected: ${fmt(d.expected)}, found: ${fmt(d.found)}`;
          }
          li.textContent = text;
          if (d.explanation) {
            const reason = document.createElement('div');
            reason.className = 'diff-reason';
            reason.textContent = d.explanation.reason;
            li.appendChild(reason);
          }
          list.appendChild(li);
        }
        if (skipCount) {
          const skipLi = document.createElement('li');
          skipLi.className = 'diff-item diff-skip';
          skipLi.textContent = `${lb.skipped.map((s) => s.label).join(', ')} — Ignored by Label`;
          list.appendChild(skipLi);
        }
        if (passCount) {
          const passLi = document.createElement('li');
          passLi.className = 'diff-item diff-pass';
          passLi.textContent = `Passed: ${lb.passed.map((p) => p.key).join(', ')}`;
          list.appendChild(passLi);
        }
        lbEl.appendChild(list);
      }

      detailsEl.appendChild(lbEl);
    }
  }
});
