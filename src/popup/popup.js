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
    const failCount = data.loadBalancers.filter((lb) => !lb.pass).length;
    const passCount = data.loadBalancers.length - failCount;

    if (failCount === 0) {
      statusIcon.className = 'icon green';
      statusText.textContent = 'All checks passed';
    } else {
      statusIcon.className = 'icon red';
      statusText.textContent = `${failCount} issue(s) found`;
    }

    resultsEl.style.display = 'block';
    lbSummary.textContent = `Load Balancers: ${passCount} pass, ${failCount} fail (${data.loadBalancers.length} total)`;
    lbSummary.className = `result-item ${failCount > 0 ? 'result-fail' : 'result-pass'}`;

    if (data.policies) {
      policyResult.style.display = 'block';
      policyResult.innerHTML = '';
      const policyDetail = document.createElement('details');
      policyDetail.className = `lb-detail ${data.policies.pass ? 'lb-pass' : 'lb-fail'}`;
      const policySummary = document.createElement('summary');
      policySummary.textContent = `Service Policies: ${data.policies.pass ? 'PASS' : 'FAIL'}`;
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

      const { policyOverrides } = await chrome.storage.local.get('policyOverrides');
      if (policyOverrides?.[namespace]) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'btn btn-sm btn-secondary';
        clearBtn.textContent = 'Clear override (use default)';
        clearBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await chrome.runtime.sendMessage({ type: 'CLEAR_POLICY_OVERRIDE', namespace });
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
      lbEl.className = `lb-detail ${lb.pass ? 'lb-pass' : 'lb-fail'}`;

      const skipCount = lb.skipped?.length || 0;
      const passCount = lb.passed?.length || 0;
      const recommendedCount = lb.diffs.filter((d) => d.required === false).length;
      const requiredFailCount = lb.diffs.filter((d) => d.required !== false).length +
        (lb.inspections || []).filter((i) => !i.pass).length;
      const summary = document.createElement('summary');
      const parts = [];
      if (passCount) parts.push(`${passCount} passed`);
      if (requiredFailCount) parts.push(`${requiredFailCount} failed`);
      if (recommendedCount) parts.push(`${recommendedCount} recommended`);
      if (skipCount) parts.push(`${skipCount} skipped`);
      summary.textContent = `${lb.pass ? '✓' : '✗'} ${lb.name} (${parts.join(', ')})`;
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

          for (const d of cat.failed) {
            const check = cat.checks?.find((c) => d.path.split('.')[1] === c.key);
            const displayName = check?.label || d.path;
            const isOptional = d.required === false;
            const li = document.createElement('li');
            li.className = `diff-item ${isOptional ? 'diff-recommended' : 'diff-fail'}`;
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
            list.appendChild(li);
          }

          for (const insp of cat.inspections || []) {
            const inspCheck = cat.checks?.find((c) => c.inspector === insp.inspector);
            const inspLabel = inspCheck?.label || insp.refName;
            if (insp.pass) {
              const li = document.createElement('li');
              li.className = 'diff-item diff-pass';
              if (inspCheck?.description) li.dataset.tooltip = inspCheck.description;
              li.textContent = inspLabel;
              list.appendChild(li);
            } else {
              for (const d of insp.diffs) {
                const li = document.createElement('li');
                li.className = 'diff-item diff-fail';
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
              const li = document.createElement('li');
              li.className = 'diff-item diff-pass';
              if (check?.description) li.dataset.tooltip = check.description;
              li.textContent = check?.label || p.key;
              list.appendChild(li);
            }
          }

          catSection.appendChild(list);
          lbEl.appendChild(catSection);
        }
      } else {
        const list = document.createElement('ul');
        list.className = 'diff-list';
        for (const d of lb.diffs) {
          const li = document.createElement('li');
          li.className = 'diff-item diff-fail';
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
