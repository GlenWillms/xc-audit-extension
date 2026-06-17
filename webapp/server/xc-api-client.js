import https from 'node:https';
import { readFileSync } from 'node:fs';

let agentCache = new Map();

function getAgent(p12Path, p12Password) {
  const key = `${p12Path}:${p12Password || ''}`;
  if (agentCache.has(key)) return agentCache.get(key);
  const pfx = readFileSync(p12Path);
  const agent = new https.Agent({ pfx, passphrase: p12Password || '' });
  agentCache.set(key, agent);
  return agent;
}

export class XcApiClient {
  constructor(tenantName, { managedTenant = null, consoleSuffix = 'console.ves.volterra.io', p12Path = null, p12Password = '', apiToken = null } = {}) {
    this.baseUrl = `https://${tenantName}.${consoleSuffix}`;
    this.managedTenant = managedTenant;
    this.p12Path = p12Path;
    this.p12Password = p12Password;
    this.apiToken = apiToken;
  }

  _prefix() {
    return this.managedTenant ? `/managed_tenant/${this.managedTenant}` : '';
  }

  async _fetch(path) {
    const url = `${this.baseUrl}${this._prefix()}${path}`;
    console.log(`[XC API] ${url}`);

    const options = { redirect: 'manual', headers: {} };

    if (this.p12Path) {
      options.dispatcher = undefined;
      // Node built-in fetch doesn't support client certs, use https.request
      return this._fetchWithCert(url);
    } else if (this.apiToken) {
      options.headers['Authorization'] = `APIToken ${this.apiToken}`;
    }

    const resp = await fetch(url, options);
    return this._handleResponse(resp, url, path);
  }

  _fetchWithCert(url) {
    const agent = getAgent(this.p12Path, this.p12Password);
    return new Promise((resolve, reject) => {
      const req = https.get(url, { agent }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 300 && res.statusCode < 400) {
            reject(new Error(`Authentication redirect (${res.statusCode}) — check your p12 certificate. Redirect: ${res.headers.location || ''}`));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            if (res.statusCode === 401 || res.statusCode === 403) {
              reject(new Error(`Authentication failed (${res.statusCode}) — check your p12 certificate and password`));
              return;
            }
            reject(new Error(`XC API ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          const ct = res.headers['content-type'] || '';
          if (!ct.includes('json') && body.trimStart().startsWith('<')) {
            reject(new Error('XC returned HTML instead of JSON — check your p12 certificate'));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Invalid JSON from XC API: ${body.slice(0, 100)}`));
          }
        });
      });
      req.on('error', reject);
    });
  }

  async _handleResponse(resp, url, path) {
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location') || '';
      throw new Error(`Authentication redirect (${resp.status}) — check credentials. Redirect: ${location.slice(0, 100)}`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`Authentication failed (${resp.status}) — check credentials`);
      }
      throw new Error(`XC API ${resp.status}: ${path} — ${body.slice(0, 200)}`);
    }
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      const body = await resp.text().catch(() => '');
      if (body.trimStart().startsWith('<')) {
        throw new Error('XC returned HTML instead of JSON — check credentials');
      }
      throw new Error(`Unexpected content-type "${contentType}" from ${path}`);
    }
    return resp.json();
  }

  async _fetchSafe(path) {
    try {
      return await this._fetch(path);
    } catch (err) {
      // For managed tenants, retry without the prefix for shared/system resources
      if (this.managedTenant) {
        try {
          return await this._fetchDirect(path);
        } catch {
          // fall through
        }
      }
      console.log(`[XC API] Soft failure: ${err.message}`);
      return null;
    }
  }

  async _fetchDirect(path) {
    const url = `${this.baseUrl}${path}`;
    if (this.p12Path) {
      return this._fetchWithCert(url);
    }
    const resp = await fetch(url, {
      headers: this.apiToken ? { 'Authorization': `APIToken ${this.apiToken}` } : {},
      redirect: 'manual',
    });
    return this._handleResponse(resp, url, path);
  }

  async listNamespaces() {
    const EXCLUDED = new Set(['shared', 'system']);
    const data = await this._fetch('/api/web/namespaces');
    return (data.items || [])
      .map(ns => ns.name || ns)
      .filter(n => n && !EXCLUDED.has(n));
  }

  async listLoadBalancers(namespace) {
    const data = await this._fetch(`/api/config/namespaces/${encodeURIComponent(namespace)}/http_loadbalancers?report_fields`);
    return data.items || [];
  }

  async getLoadBalancer(namespace, name) {
    return this._fetch(`/api/config/namespaces/${encodeURIComponent(namespace)}/http_loadbalancers/${encodeURIComponent(name)}?report_fields`);
  }

  async getActiveServicePolicies(namespace) {
    return this._fetchSafe(`/api/config/namespaces/${encodeURIComponent(namespace)}/active_service_policies?report_fields`);
  }

  async getAppFirewall(namespace, name) {
    return this._fetchSafe(`/api/config/namespaces/${encodeURIComponent(namespace)}/app_firewalls/${encodeURIComponent(name)}?report_fields`);
  }

  async getServicePolicy(namespace, name) {
    return this._fetchSafe(`/api/config/namespaces/${encodeURIComponent(namespace)}/service_policys/${encodeURIComponent(name)}?report_fields`);
  }

  async getTenantSettings() {
    return this._fetchSafe('/api/web/namespaces/system/tenant/settings');
  }

  async getTenantIdmSettings() {
    return this._fetchSafe('/api/web/namespaces/system/tenant/idm/settings');
  }

  async getGlobalLogReceivers() {
    return this._fetchSafe('/api/config/namespaces/system/global_log_receivers?report_fields');
  }

  async getQuotaUsage() {
    return this._fetchSafe('/api/web/namespaces/system/quota/usage');
  }

  async listManagedTenants() {
    const data = await this._fetch('/api/web/namespaces/system/managed_tenants_by_user?page_limit=100');
    return (data.access_config || [])
      .filter(t => t.tenant_status === 'TENANT_STATUS_ACTIVE')
      .map(t => ({
        name: t.link?.name || t.name,
        fullName: t.name,
        groups: (t.groups || []).flatMap(g => g.managed_tenant_groups || []),
      }));
  }
}
