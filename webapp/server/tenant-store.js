import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encrypt, decrypt } from './crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const TENANTS_FILE = join(DATA_DIR, 'tenants.json');
const SECRETS_FILE = join(DATA_DIR, 'secrets.json');

let writeLock = Promise.resolve();

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function writeJson(path, data) {
  const prev = writeLock;
  writeLock = prev.then(async () => {
    await ensureDataDir();
    await writeFile(path, JSON.stringify(data, null, 2));
  }).catch(() => {});
  await writeLock;
}

// --- Secrets store (encrypted at rest) ---

async function readSecrets() {
  const raw = await readJson(SECRETS_FILE);
  if (!raw) return {};
  const decrypted = {};
  for (const [id, entry] of Object.entries(raw)) {
    decrypted[id] = {};
    for (const [k, v] of Object.entries(entry)) {
      decrypted[id][k] = decrypt(v);
    }
  }
  return decrypted;
}

async function writeSecrets(secrets) {
  const encrypted = {};
  for (const [id, entry] of Object.entries(secrets)) {
    encrypted[id] = {};
    for (const [k, v] of Object.entries(entry)) {
      encrypted[id][k] = v ? encrypt(v) : '';
    }
  }
  await writeJson(SECRETS_FILE, encrypted);
}

async function getSecrets(id) {
  const all = await readSecrets();
  return all[id] || {};
}

async function setSecrets(id, values) {
  const all = await readSecrets();
  all[id] = { ...(all[id] || {}), ...values };
  await writeSecrets(all);
}

async function deleteSecrets(id) {
  const all = await readSecrets();
  delete all[id];
  await writeSecrets(all);
}

// --- Tenants store (plain config) ---

async function readTenants() {
  return (await readJson(TENANTS_FILE)) || [];
}

async function writeTenantsFile(tenants) {
  await writeJson(TENANTS_FILE, tenants);
}

export async function listTenants() {
  const tenants = await readTenants();
  const secrets = await readSecrets();
  return tenants.map(t => ({
    ...t,
    hasCredential: !!(t.p12Path || secrets[t.id]?.apiToken),
    managedTenants: (t.managedTenants || []).map(m => ({ ...m })),
  }));
}

export async function getTenant(id) {
  const tenants = await readTenants();
  return tenants.find(t => t.id === id) || null;
}

export async function addTenant({ name, tenant, p12Path, p12Password, apiToken, credentialExpiry, consoleSuffix, plan, addons }) {
  const tenants = await readTenants();
  const id = randomUUID();
  const entry = {
    id,
    name: name || tenant,
    tenant,
    p12Path: p12Path || null,
    credentialExpiry: credentialExpiry || null,
    consoleSuffix: consoleSuffix || 'console.ves.volterra.io',
    plan: plan || 'essentials',
    addons: addons || [],
    managedTenants: [],
  };
  tenants.push(entry);
  await writeTenantsFile(tenants);
  await setSecrets(id, { p12Password: p12Password || '', apiToken: apiToken || '' });
  return { ...entry, hasCredential: !!(p12Path || apiToken), managedTenants: [] };
}

export async function updateTenant(id, updates) {
  const tenants = await readTenants();
  const idx = tenants.findIndex(t => t.id === id);
  if (idx === -1) return null;

  const configFields = ['name', 'tenant', 'p12Path', 'credentialExpiry', 'consoleSuffix', 'plan', 'addons'];
  for (const key of configFields) {
    if (key in updates) tenants[idx][key] = updates[key];
  }
  await writeTenantsFile(tenants);

  const secretUpdates = {};
  if ('p12Password' in updates) secretUpdates.p12Password = updates.p12Password || '';
  if ('apiToken' in updates) secretUpdates.apiToken = updates.apiToken || '';
  if (Object.keys(secretUpdates).length) await setSecrets(id, secretUpdates);

  const secrets = await getSecrets(id);
  return {
    ...tenants[idx],
    hasCredential: !!(tenants[idx].p12Path || secrets.apiToken),
    managedTenants: tenants[idx].managedTenants || [],
  };
}

export async function deleteTenant(id) {
  const tenants = await readTenants();
  const filtered = tenants.filter(t => t.id !== id);
  if (filtered.length === tenants.length) return false;
  await writeTenantsFile(filtered);
  await deleteSecrets(id);
  return true;
}

// --- Managed tenant operations ---

export async function addManagedTenant(parentId, { name, tenant, plan, addons }) {
  const tenants = await readTenants();
  const parent = tenants.find(t => t.id === parentId);
  if (!parent) return null;
  if (!parent.managedTenants) parent.managedTenants = [];
  const entry = {
    id: randomUUID(),
    name: name || tenant,
    tenant,
    plan: plan || parent.plan,
    addons: addons || [...(parent.addons || [])],
  };
  parent.managedTenants.push(entry);
  await writeTenantsFile(tenants);
  return entry;
}

export async function updateManagedTenant(parentId, managedId, updates) {
  const tenants = await readTenants();
  const parent = tenants.find(t => t.id === parentId);
  if (!parent) return null;
  const managed = (parent.managedTenants || []).find(m => m.id === managedId);
  if (!managed) return null;
  const allowed = ['name', 'tenant', 'plan', 'addons'];
  for (const key of allowed) {
    if (key in updates) managed[key] = updates[key];
  }
  await writeTenantsFile(tenants);
  return managed;
}

export async function deleteManagedTenant(parentId, managedId) {
  const tenants = await readTenants();
  const parent = tenants.find(t => t.id === parentId);
  if (!parent || !parent.managedTenants) return false;
  const before = parent.managedTenants.length;
  parent.managedTenants = parent.managedTenants.filter(m => m.id !== managedId);
  if (parent.managedTenants.length === before) return false;
  await writeTenantsFile(tenants);
  return true;
}

export async function resolveTenantConfig(parentId, managedId) {
  const parent = await getTenant(parentId);
  if (!parent) return null;
  const secrets = await getSecrets(parentId);
  const base = {
    tenant: parent.tenant,
    p12Path: parent.p12Path,
    p12Password: secrets.p12Password || '',
    apiToken: secrets.apiToken || '',
    consoleSuffix: parent.consoleSuffix,
  };
  if (!managedId) {
    return { ...base, managedTenant: null, plan: parent.plan, addons: parent.addons || [], name: parent.name };
  }
  const managed = (parent.managedTenants || []).find(m => m.id === managedId);
  if (!managed) return null;
  return {
    ...base,
    managedTenant: managed.tenant,
    plan: managed.plan || parent.plan,
    addons: managed.addons || parent.addons || [],
    name: managed.name || managed.tenant,
  };
}
