import { Router } from 'express';
import {
  listTenants, addTenant, updateTenant, deleteTenant,
  addManagedTenant, updateManagedTenant, deleteManagedTenant,
  resolveTenantConfig,
} from './tenant-store.js';
import { XcApiClient } from './xc-api-client.js';
import { runFullReport, getAsset } from './audit-orchestrator.js';

const router = Router();

function wrap(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function makeClient(config) {
  return new XcApiClient(config.tenant, {
    managedTenant: config.managedTenant,
    consoleSuffix: config.consoleSuffix,
    p12Path: config.p12Path,
    p12Password: config.p12Password,
    apiToken: config.apiToken,
  });
}

// --- Parent tenant CRUD ---

router.get('/tenants', wrap(async (req, res) => {
  res.json(await listTenants());
}));

router.post('/tenants', wrap(async (req, res) => {
  const { name, tenant, p12Path, p12Password, apiToken, credentialExpiry, consoleSuffix, plan, addons } = req.body;
  if (!tenant) {
    return res.status(400).json({ error: 'tenant is required' });
  }
  if (!p12Path && !apiToken) {
    return res.status(400).json({ error: 'Either p12Path or apiToken is required' });
  }
  const result = await addTenant({ name, tenant, p12Path, p12Password, apiToken, credentialExpiry, consoleSuffix, plan, addons });
  res.status(201).json(result);
}));

router.put('/tenants/:id', wrap(async (req, res) => {
  const result = await updateTenant(req.params.id, req.body);
  if (!result) return res.status(404).json({ error: 'Tenant not found' });
  res.json(result);
}));

router.delete('/tenants/:id', wrap(async (req, res) => {
  const ok = await deleteTenant(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Tenant not found' });
  res.json({ ok: true });
}));

// --- Managed tenant CRUD ---

router.post('/tenants/:id/managed', wrap(async (req, res) => {
  const { name, tenant, plan, addons } = req.body;
  if (!tenant) {
    return res.status(400).json({ error: 'tenant (managed tenant name) is required' });
  }
  const result = await addManagedTenant(req.params.id, { name, tenant, plan, addons });
  if (!result) return res.status(404).json({ error: 'Parent tenant not found' });
  res.status(201).json(result);
}));

router.put('/tenants/:id/managed/:mid', wrap(async (req, res) => {
  const result = await updateManagedTenant(req.params.id, req.params.mid, req.body);
  if (!result) return res.status(404).json({ error: 'Managed tenant not found' });
  res.json(result);
}));

router.delete('/tenants/:id/managed/:mid', wrap(async (req, res) => {
  const ok = await deleteManagedTenant(req.params.id, req.params.mid);
  if (!ok) return res.status(404).json({ error: 'Managed tenant not found' });
  res.json({ ok: true });
}));

// --- Managed tenant discovery ---

router.get('/tenants/:id/discover-managed', wrap(async (req, res) => {
  const config = await resolveTenantConfig(req.params.id, null);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  try {
    const client = makeClient(config);
    const discovered = await client.listManagedTenants();
    res.json(discovered);
  } catch (err) {
    res.status(502).json({ error: `XC API error: ${err.message}` });
  }
}));

// --- Namespace discovery (works for both parent and managed) ---

router.get('/tenants/:id/namespaces', wrap(async (req, res) => {
  const config = await resolveTenantConfig(req.params.id, null);
  if (!config) return res.status(404).json({ error: 'Tenant not found' });
  try {
    res.json(await makeClient(config).listNamespaces());
  } catch (err) {
    res.status(502).json({ error: `XC API error: ${err.message}` });
  }
}));

router.get('/tenants/:id/managed/:mid/namespaces', wrap(async (req, res) => {
  const config = await resolveTenantConfig(req.params.id, req.params.mid);
  if (!config) return res.status(404).json({ error: 'Managed tenant not found' });
  try {
    res.json(await makeClient(config).listNamespaces());
  } catch (err) {
    res.status(502).json({ error: `XC API error: ${err.message}` });
  }
}));

// --- Audit execution with SSE progress ---

function handleAudit(resolveConfig) {
  return wrap(async (req, res) => {
    const config = await resolveConfig(req);
    if (!config) return res.status(404).json({ error: 'Tenant not found' });

    const { namespaces } = req.body;
    if (!Array.isArray(namespaces) || namespaces.length === 0) {
      return res.status(400).json({ error: 'namespaces array is required' });
    }

    const nsPattern = /^[a-zA-Z0-9_-]+$/;
    for (const ns of namespaces) {
      if (!nsPattern.test(ns)) {
        return res.status(400).json({ error: `Invalid namespace name: ${ns}` });
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    function sendEvent(type, data) {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    }

    try {
      const client = makeClient(config);
      const result = await runFullReport(client, namespaces, config, msg => sendEvent('progress', { message: msg }));
      sendEvent('complete', result);
    } catch (err) {
      sendEvent('error', { message: err.message });
    }

    res.end();
  });
}

router.post('/tenants/:id/audit', handleAudit(req => resolveTenantConfig(req.params.id, null)));
router.post('/tenants/:id/managed/:mid/audit', handleAudit(req => resolveTenantConfig(req.params.id, req.params.mid)));

// --- Static assets ---

router.get('/assets/:name', (req, res) => {
  const data = getAsset(req.params.name);
  if (!data) return res.status(404).json({ error: 'Asset not found' });
  res.json(data);
});

export default router;
