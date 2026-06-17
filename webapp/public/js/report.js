import { goTo } from './app.js';

export function renderReport(container) {
  // Access the last audit result from the audit module
  const result = window.__lastAuditResult;

  if (!result?.reportHtml) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No report available. Run an audit first.</p>
        <button class="btn-primary" onclick="location.hash='audit'">Go to Audit</button>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="report-toolbar">
      <button class="btn-secondary" id="back-to-audit">Back to Audit</button>
      <button class="btn-primary" id="download-report">Download HTML</button>
      <button class="btn-secondary" id="expand-all">Expand All</button>
      <button class="btn-secondary" id="collapse-all">Collapse All</button>
      <button class="btn-secondary" id="print-report">Print</button>
    </div>
    <iframe class="report-frame" id="report-iframe" sandbox="allow-same-origin allow-modals"></iframe>
  `;

  const iframe = document.getElementById('report-iframe');
  iframe.srcdoc = result.reportHtml;

  document.getElementById('back-to-audit').onclick = () => goTo('audit');

  document.getElementById('download-report').onclick = () => {
    const blob = new Blob([result.reportHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xc-audit-report-${new Date().toISOString().slice(0, 10)}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById('print-report').onclick = () => {
    iframe.contentWindow.print();
  };

  document.getElementById('expand-all').onclick = () => {
    const doc = iframe.contentDocument;
    if (doc) doc.querySelectorAll('details').forEach(d => d.open = true);
  };

  document.getElementById('collapse-all').onclick = () => {
    const doc = iframe.contentDocument;
    if (doc) doc.querySelectorAll('details').forEach(d => d.open = false);
  };
}
