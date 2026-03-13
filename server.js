import { createServer } from 'http';
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3033;
const DOCS_DATA = join(__dirname, 'docs', 'data.json');

function latestFile(dir, prefix) {
  const files = readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) throw new Error(`No ${prefix}* files in ${dir}`);
  return join(dir, files[0]);
}

const CONFIRMED_FILE = join(__dirname, 'confirmed_matches.json');

function loadConfirmed() {
  if (!existsSync(CONFIRMED_FILE)) return [];
  return JSON.parse(readFileSync(CONFIRMED_FILE, 'utf8'));
}

function saveConfirmed(list) {
  writeFileSync(CONFIRMED_FILE, JSON.stringify(list, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── POST /api/resync ───────────────────────────────────────────────────────
  if (url.pathname === '/api/resync' && req.method === 'POST') {
    try {
      await new Promise((resolve, reject) => {
        execFile(process.execPath, [join(__dirname, 'sync.js')], { cwd: __dirname, timeout: 120_000 }, (err, stdout, stderr) => {
          if (stdout) console.log(stdout);
          if (stderr) console.error(stderr);
          if (err) return reject(err);
          resolve();
        });
      });
      // Return fresh data after sync
      const outputDir = join(__dirname, 'output');
      const mapFile  = latestFile(outputDir, 'migration_map_');
      const usaFile  = latestFile(outputDir, 'usa_backup_');
      const euFile   = latestFile(outputDir, 'eu_inventory_');
      const map      = JSON.parse(readFileSync(mapFile, 'utf8'));
      const timestamp = mapFile.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/)?.[1]?.replace('T', ' ').replace(/-/g, (m, o) => o > 10 ? ':' : '-') ?? '';
      // Update docs/data.json for GitHub Pages (includes timestamp)
      writeFileSync(DOCS_DATA, JSON.stringify({ map, timestamp }));
      console.log(`[resync] Updated ${DOCS_DATA}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ map, timestamp, mapFile, usaFile, euFile }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/confirm-match ──────────────────────────────────────────────
  if (url.pathname === '/api/confirm-match' && req.method === 'POST') {
    try {
      const { usa_agent_id, eu_agent_id, usa_name, eu_name } = await readBody(req);
      const confirmed = loadConfirmed();
      // Upsert by usa_agent_id
      const idx = confirmed.findIndex(c => c.usa_agent_id === usa_agent_id);
      const entry = { usa_agent_id, eu_agent_id, usa_name, eu_name, confirmed_at: new Date().toISOString() };
      if (idx >= 0) confirmed[idx] = entry; else confirmed.push(entry);
      saveConfirmed(confirmed);

      // Also patch the latest migration_map in memory so /api/data reflects the change
      const outputDir = join(__dirname, 'output');
      const mapFile = latestFile(outputDir, 'migration_map_');
      const map = JSON.parse(readFileSync(mapFile, 'utf8'));
      const row = map.usa_to_eu.find(r => r.usa_agent_id === usa_agent_id);
      if (row) {
        row.status = row.diff_fields && row.diff_fields.length > 0 ? 'MIGRATED_WITH_DIFFS' : 'MIGRATED_IDENTICAL';
        row.eu_agent_id = eu_agent_id;
        row.eu_name = eu_name;
        delete row.similarity_score;
        writeFileSync(mapFile, JSON.stringify(map, null, 2));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entry }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/data') {
    try {
      const outputDir = join(__dirname, 'output');
      const mapFile  = latestFile(outputDir, 'migration_map_');
      const usaFile  = latestFile(outputDir, 'usa_backup_');
      const euFile   = latestFile(outputDir, 'eu_inventory_');
      const map      = JSON.parse(readFileSync(mapFile, 'utf8'));
      const timestamp = mapFile.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/)?.[1]?.replace('T', ' ').replace(/-/g, (m, o) => o > 10 ? ':' : '-') ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ map, timestamp, mapFile, usaFile, euFile }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve static files from public/
  const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const content = readFileSync(join(__dirname, 'public', filePath));
    const ext = filePath.split('.').pop();
    const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css' }[ext] ?? 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
