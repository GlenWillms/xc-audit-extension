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

const TENANT_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const CONSOLE_SUFFIX_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z]{2,}$/;

export class XcApiClient {
  constructor(tenantName, { managedTenant = null, consoleSuffix = 'console.ves.volterra.io', p12Path = null, p12Password = '', apiToken = null } = {}) {
    if (!TENANT_NAME_RE.test(tenantName)) throw new Error('Invalid tenant name');
    if (!CONSOLE_SUFFIX_RE.test(consoleSuffix) || consoleSuffix.includes('..')) throw new Error('Invalid console suffix');
    this.tenantName = tenantName;
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
      options.headers['x-volterra-apigw-tenant'] = this.tenantName;
    }

    const resp = await fetch(url, options);
    return this._handleResponse(resp, url, path);
  }

  _fetchWithCert(url) {
    const agent = getAgent(this.p12Path, this.p12Password);
    return new Promise((resolve, reject) => {
      const req = https.get(url, { agent, headers: { 'x-volterra-apigw-tenant': this.tenantName } }, (res) => {
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
      if (this.managedTenant) {
        try {
          return await this._fetchDirect(path);
        } catch {
          // fall through
        }
      }
      console.log(`[XC API] Soft failure: ${err.message}`);
      if (err.message.includes('(403)') || err.message.includes('(401)')) {
        return { __forbidden: true };
      }
      return null;
    }
  }

  async _fetchDirect(path) {
    const url = `${this.baseUrl}${path}`;
    if (this.p12Path) {
      return this._fetchWithCert(url);
    }
    const resp = await fetch(url, {
      headers: this.apiToken ? { 'Authorization': `APIToken ${this.apiToken}`, 'x-volterra-apigw-tenant': this.tenantName } : {},
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

  async getCustomLogo() {
    const path = '/api/web/namespaces/system/tenant/settings/tenant/image';
    try {
      const url = `${this.baseUrl}${this._prefix()}${path}`;
      if (this.p12Path) {
        const agent = getAgent(this.p12Path, this.p12Password);
        return await new Promise((resolve) => {
          const chunks = [];
          const req = https.get(url, { agent }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            const ct = (res.headers['content-type'] || '').split(';')[0].trim();
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
              const buf = Buffer.concat(chunks);
              if (ct.startsWith('image/')) {
                resolve(`data:${ct};base64,${buf.toString('base64')}`);
              } else {
                resolve(this._extractLogoFromJson(buf.toString('utf8')));
              }
            });
          });
          req.on('error', () => resolve(null));
        });
      }
      const options = { redirect: 'manual', headers: {} };
      if (this.apiToken) {
        options.headers['Authorization'] = `APIToken ${this.apiToken}`;
        options.headers['x-volterra-apigw-tenant'] = this.tenantName;
      }
      const resp = await fetch(url, options);
      if (!resp.ok) return null;
      const ct = (resp.headers.get('content-type') || '').split(';')[0].trim();
      if (ct.startsWith('image/')) {
        const buf = Buffer.from(await resp.arrayBuffer());
        return `data:${ct};base64,${buf.toString('base64')}`;
      }
      const body = await resp.text();
      return this._extractLogoFromJson(body);
    } catch {
      return null;
    }
  }

  _extractLogoFromJson(body) {
    try {
      const data = JSON.parse(body);
      const raw = data.data || data.image || data.image_data || data.logo || data.content;
      if (raw && typeof raw === 'string') {
        if (raw.startsWith('data:image')) return raw;
        if (raw.length > 100) return `data:image/png;base64,${raw}`;
      }
    } catch { /* not JSON */ }
    return null;
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
