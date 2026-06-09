const XC_URL_PATTERN =
  /^https:\/\/([^.]+)\.console\.ves\.volterra\.io\/web\/workspaces\/([^/]+)\/(.+)/;
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

  if (!match || !LB_LIST_PATH.test(match[3])) {
    statusIcon.className = 'icon gray';
    statusText.textContent = 'Not on LB list page';
    notOnPage.style.display = 'block';
    return;
  }

  const nsMatch = match[3].match(NAMESPACE_SEGMENT);
  const tenant = match[1];
  const namespace = nsMatch ? nsMatch[1] : match[2];

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

  const cached = auditCache?.[`${tenant}/${namespace}`];

  if (cached) {
    renderResults(cacheToResults(cached));
  } else {
    statusIcon.className = 'icon gray';
    statusText.textContent = 'Audit in progress...';

    chrome.storage.session.onChanged.addListener((changes) => {
      if (!changes.auditCache) return;
      const entry = changes.auditCache.newValue?.[`${tenant}/${namespace}`];
      if (entry) renderResults(cacheToResults(entry));
    });
  }

  function fmt(val) {
    if (val === null || val === undefined) return String(val);
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }

  function renderResults(data) {
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

      policyResult.appendChild(policyDetail);
    }

    const detailsEl = document.getElementById('lbDetails');
    detailsEl.innerHTML = '';
    for (const lb of data.loadBalancers) {
      const lbEl = document.createElement('details');
      lbEl.className = `lb-detail ${lb.pass ? 'lb-pass' : 'lb-fail'}`;

      const skipCount = lb.skipped?.length || 0;
      const passCount = lb.passed?.length || 0;
      const failCount = lb.diffs.length;
      const summary = document.createElement('summary');
      const parts = [];
      if (passCount) parts.push(`${passCount} passed`);
      if (failCount) parts.push(`${failCount} failed`);
      if (skipCount) parts.push(`${skipCount} skipped`);
      summary.textContent = `${lb.pass ? '✓' : '✗'} ${lb.name} (${parts.join(', ')})`;
      lbEl.appendChild(summary);

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
        skipLi.textContent = `Skipped: ${lb.skipped.map((s) => s.label).join(', ')}`;
        list.appendChild(skipLi);
      }
      if (passCount) {
        const passLi = document.createElement('li');
        passLi.className = 'diff-item diff-pass';
        passLi.textContent = `Passed: ${lb.passed.map((p) => p.key).join(', ')}`;
        list.appendChild(passLi);
      }
      lbEl.appendChild(list);

      detailsEl.appendChild(lbEl);
    }
  }
});
