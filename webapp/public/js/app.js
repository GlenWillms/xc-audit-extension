import { renderTenants } from './tenants.js';
import { renderAudit } from './audit.js';
import { renderReport } from './report.js';

const views = {
  tenants: { el: () => document.getElementById('view-tenants'), render: renderTenants },
  audit: { el: () => document.getElementById('view-audit'), render: renderAudit },
  report: { el: () => document.getElementById('view-report'), render: renderReport },
};

function navigate() {
  const hash = location.hash.replace('#', '') || 'tenants';
  const [view, ...params] = hash.split('/');

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));

  const target = views[view];
  if (target) {
    target.el().classList.add('active');
    const tab = document.querySelector(`.nav-tab[data-tab="${view}"]`);
    if (tab) tab.classList.add('active');
    target.render(target.el(), params);
  }
}

export function goTo(hash) {
  location.hash = hash;
}

export async function api(path, options = {}) {
  const resp = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || resp.statusText);
  }
  return resp.json();
}

export function escapeHtml(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

window.addEventListener('hashchange', navigate);
window.addEventListener('DOMContentLoaded', navigate);
