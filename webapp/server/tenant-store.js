import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encrypt, decrypt } from './crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const TENANTS_FILE = join(DATA_DIR, 'tenants.json');

const SECRET_FIELDS = ['p12Password', 'apiToken'];

let writeLock = Promise.resolve();

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

function decryptTenant(t) {
  const copy = { ...t };
  for (const key of SECRET_FIELDS) {
    if (copy[key]) copy[key] = decrypt(copy[key]);
  }
  return copy;
}

function encryptTenant(t) {
  const copy = { ...t };
  for (const key of SECRET_FIELDS) {
    if (copy[key]) copy[key] = encrypt(copy[key]);
  }
  return copy;
}

async function readTenants() {
  try {
    const raw = await readFile(TENANTS_FILE, 'utf-8');
    return JSON.parse(raw).map(decryptTenant);
  } catch {
    return [];
  }
}

async function writeTenants(tenants) {
  const encrypted = tenants.map(encryptTenant);
  const prev = writeLock;
  writeLock = prev.then(async () => {
    await ensureDataDir();
    await writeFile(TENANTS_FILE, JSON.stringify(encrypted, null, 2));
  }).catch(() => {});
  await writeLock;
}

function sanitize({ p12Password, apiToken, ...rest }) {
  return { ...rest, hasCredential: !!(rest.p12Path || apiToken) };
}

export async function listTenants() {
  const tenants = await readTenants();
  return tenants.map(t => ({
    ...sanitize(t),
    managedTenants: (t.managedTenants || []).map(m => ({ ...m })),
  }));
}

export async function getTenant(id) {
  const tenants = await readTenants();
  return tenants.find(t => t.id === id) || null;
}

export async function addTenant({ name, tenant, p12Path, p12Password, apiToken, consoleSuffix, plan, addons }) {
  const tenants = await readTenants();
  const entry = {
    id: randomUUID(),
    name: name || tenant,
    tenant,
    p12Path: p12Path || null,
    p12Password: p12Password || '',
    apiToken: apiToken || null,
    consoleSuffix: consoleSuffix || 'console.ves.volterra.io',
    plan: plan || 'essentials',
    addons: addons || [],
    managedTenants: [],
  };
  tenants.push(entry);
  await writeTenants(tenants);
  return { ...sanitize(entry), managedTenants: [] };
}

export async function updateTenant(id, updates) {
  const tenants = await readTenants();
  const idx = tenants.findIndex(t => t.id === id);
  if (idx === -1) return null;
  const allowed = ['name', 'tenant', 'p12Path', 'p12Password', 'apiToken', 'consoleSuffix', 'plan', 'addons'];
  for (const key of allowed) {
    if (key in updates) tenants[idx][key] = updates[key];
  }
  await writeTenants(tenants);
  return {
    ...sanitize(tenants[idx]),
    managedTenants: tenants[idx].managedTenants || [],
  };
}

export async function deleteTenant(id) {
  const tenants = await readTenants();
  const filtered = tenants.filter(t => t.id !== id);
  if (filtered.length === tenants.length) return false;
  await writeTenants(filtered);
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
  await writeTenants(tenants);
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
  await writeTenants(tenants);
  return managed;
}

export async function deleteManagedTenant(parentId, managedId) {
  const tenants = await readTenants();
  const parent = tenants.find(t => t.id === parentId);
  if (!parent || !parent.managedTenants) return false;
  const before = parent.managedTenants.length;
  parent.managedTenants = parent.managedTenants.filter(m => m.id !== managedId);
  if (parent.managedTenants.length === before) return false;
  await writeTenants(tenants);
  return true;
}

export async function resolveTenantConfig(parentId, managedId) {
  const parent = await getTenant(parentId);
  if (!parent) return null;
  if (!managedId) {
    return {
      tenant: parent.tenant,
      p12Path: parent.p12Path,
      p12Password: parent.p12Password,
      apiToken: parent.apiToken,
      consoleSuffix: parent.consoleSuffix,
      managedTenant: null,
      plan: parent.plan,
      addons: parent.addons || [],
      name: parent.name,
    };
  }
  const managed = (parent.managedTenants || []).find(m => m.id === managedId);
  if (!managed) return null;
  return {
    tenant: parent.tenant,
    p12Path: parent.p12Path,
    p12Password: parent.p12Password,
    apiToken: parent.apiToken,
    consoleSuffix: parent.consoleSuffix,
    managedTenant: managed.tenant,
    plan: managed.plan || parent.plan,
    addons: managed.addons || parent.addons || [],
    name: managed.name || managed.tenant,
  };
}
