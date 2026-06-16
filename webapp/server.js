import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import express from 'express';
import { initCrypto } from './server/crypto.js';
import routes from './server/routes.js';
import { loadAssets } from './server/audit-orchestrator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';

function loadEnv() {
  try {
    const envPath = join(__dirname, '.env');
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env file is optional if MASTER_PASSWORD is already set via environment
  }
}

const app = express();

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use('/api', routes);

app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  loadEnv();
  initCrypto(process.env.MASTER_PASSWORD);

  await mkdir(join(__dirname, 'data'), { recursive: true });
  await loadAssets();

  const server = app.listen(PORT, HOST, () => {
    console.log(`XC Audit Webapp running at http://${HOST}:${PORT}`);
  });

  process.on('SIGINT', () => { server.close(); process.exit(0); });
  process.on('SIGTERM', () => { server.close(); process.exit(0); });
}

start().catch(err => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
