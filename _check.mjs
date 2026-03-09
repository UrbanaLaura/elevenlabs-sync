import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '.env'), 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.split('=').map(s => s.trim()))
    .filter(([k]) => k)
);

const USA_IDS = [
  'agent_5301k6g4fraaed48wc21846hny46',
  'agent_4501k6dms10qftr8am3rkgjv3sfe',
  'agent_8301k62q3x7xer3a4xcwafz65rjz',
  'agent_4201k62pce3jew880b61vgk68x0q',
  'agent_1501k5v36n63fdm870vb00gdeqph',
  'agent_9901k5epyvj3fk2seefa5pn0pze4',
  'agent_3701k5bmgcztfa89dzjrgdehmgsg',
  'agent_8601k56chfrrewqr8mq3ws036jd4',
  'agent_0801k4s4cjv9e0y9nkdcr2w8r1fs',
  'agent_3101k49rwfjperxsgyrvq8c2jy7f',
  'agent_01jzw6kzrdfq3b7d325h27xh5d',
  'agent_01jzmfzpxmewcaq7gzrq3jqnn6',
  'agent_01jzafdg1pespt69gpnd74jcg2',
  'agent_01jz7g9pavftn93s8wfhz8rjkt',
  'agent_01jz2bc8dqe3evhhfdj175e7j8',
  'agent_01jyp9grq6fxf8wjt372n89sp2',
  'agent_01jxfp5g37f1ka3nybnwzevcp4',
  'agent_01jwdfqtpfftdsgdpeg50ttd15',
  'ZwZb8bPj7HFKnYqKkhLZ',
];

async function apiFetch(baseUrl, key, path) {
  const res = await fetch(baseUrl + path, { headers: { 'xi-api-key': key } });
  if (!res.ok) return null;
  return res.json();
}

async function listAll(baseUrl, key) {
  let agents = [], cursor = null;
  while (true) {
    const qs = cursor ? `?cursor=${cursor}&page_size=100` : '?page_size=100';
    const data = await apiFetch(baseUrl, key, '/v1/convai/agents' + qs);
    agents = agents.concat(data.agents ?? []);
    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return agents;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}
function sim(a, b) {
  const na = a.toLowerCase().trim(), nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  return 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
}

function extractConfig(agent) {
  return {
    system_prompt: agent.conversation_config?.agent?.prompt?.prompt ?? null,
    first_message: agent.conversation_config?.agent?.first_message ?? null,
    voice_id:      agent.conversation_config?.tts?.voice_id ?? null,
  };
}

console.log('Fetching EU agent list...');
const euList = await listAll(env.ELEVENLABS_EU_URL, env.ELEVENLABS_EU_KEY);
console.log(`EU has ${euList.length} agents\n`);

const euByName = new Map(euList.map(a => [a.name.toLowerCase().trim(), a]));

const results = { exact: [], fuzzy: [], none: [], notFound: [] };

for (const id of USA_IDS) {
  const agent = await apiFetch(env.ELEVENLABS_USA_URL, env.ELEVENLABS_USA_KEY, `/v1/convai/agents/${id}`);
  if (!agent?.agent_id) {
    results.notFound.push(id);
    continue;
  }
  const name = agent.name;
  const nameLower = name.toLowerCase().trim();

  if (euByName.has(nameLower)) {
    const eu = euByName.get(nameLower);
    const usaCfg = extractConfig(agent);
    const euCfg  = extractConfig(eu);
    const diffs  = Object.keys(usaCfg).filter(k => JSON.stringify(usaCfg[k]) !== JSON.stringify(euCfg[k]));
    results.exact.push({ usaId: id, euId: eu.agent_id, name, diffs, usaCfg, euCfg });
  } else {
    let best = null, bestScore = 0;
    for (const eu of euList) {
      const s = sim(name, eu.name ?? '');
      if (s > bestScore) { bestScore = s; best = eu; }
    }
    if (best && bestScore >= 0.75) {
      const usaCfg = extractConfig(agent);
      const euCfg  = extractConfig(best);
      const diffs  = Object.keys(usaCfg).filter(k => JSON.stringify(usaCfg[k]) !== JSON.stringify(euCfg[k]));
      results.fuzzy.push({ usaId: id, euId: best.agent_id, usaName: name, euName: best.name, score: Math.round(bestScore*100), diffs, usaCfg, euCfg });
    } else {
      results.none.push({ usaId: id, name });
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (results.notFound.length) {
  console.log('═══ NOT FOUND IN USA ═══');
  results.notFound.forEach(id => console.log(`  ${id}`));
  console.log();
}

if (results.exact.length) {
  console.log('═══ EXACT NAME MATCH (already in EU) ═══');
  for (const r of results.exact) {
    if (r.diffs.length === 0) {
      console.log(`  ✓ IDENTICAL  | "${r.name}"\n    USA: ${r.usaId}\n    EU:  ${r.euId}`);
    } else {
      console.log(`  ⚠ WITH DIFFS | "${r.name}" — diffs: ${r.diffs.join(', ')}\n    USA: ${r.usaId}\n    EU:  ${r.euId}`);
      for (const d of r.diffs) {
        const uv = String(r.usaCfg[d] ?? '—').slice(0, 120);
        const ev = String(r.euCfg[d]  ?? '—').slice(0, 120);
        console.log(`      [${d}]`);
        console.log(`        USA: ${uv}`);
        console.log(`        EU:  ${ev}`);
      }
    }
    console.log();
  }
}

if (results.fuzzy.length) {
  console.log('═══ FUZZY NAME MATCH (needs manual review) ═══');
  for (const r of results.fuzzy) {
    console.log(`  ? ${r.score}% similar | USA: "${r.usaName}" <-> EU: "${r.euName}"`);
    console.log(`    USA: ${r.usaId}`);
    console.log(`    EU:  ${r.euId}`);
    if (r.diffs.length === 0) {
      console.log(`    Config: IDENTICAL`);
    } else {
      console.log(`    Config diffs: ${r.diffs.join(', ')}`);
      for (const d of r.diffs) {
        const uv = String(r.usaCfg[d] ?? '—').slice(0, 120);
        const ev = String(r.euCfg[d]  ?? '—').slice(0, 120);
        console.log(`      [${d}]`);
        console.log(`        USA: ${uv}`);
        console.log(`        EU:  ${ev}`);
      }
    }
    console.log();
  }
}

if (results.none.length) {
  console.log('═══ NO MATCH IN EU (will be migrated) ═══');
  for (const r of results.none) {
    console.log(`  → "${r.name}" (${r.usaId})`);
  }
}
