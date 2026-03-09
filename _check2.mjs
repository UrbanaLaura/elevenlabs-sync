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
  'agent_3201k7pxmha3fhsawdtavnk1jr27',
  'agent_7301k7pkgrbafxj9tw9ttddebta1',
  'agent_7101k7h4favke5zvyh1xznvh1wmt',
  'agent_9201k74968dge7yat0p3vj9hz05a',
  'agent_6801k7256s48ev2vagx1q41eaczy',
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

for (const id of USA_IDS) {
  const agent = await apiFetch(env.ELEVENLABS_USA_URL, env.ELEVENLABS_USA_KEY, `/v1/convai/agents/${id}`);
  if (!agent?.agent_id) {
    console.log(`NOT FOUND: ${id}`);
    continue;
  }
  const name = agent.name;
  const nameLower = name.toLowerCase().trim();
  const kbCount = agent.conversation_config?.agent?.prompt?.knowledge_base?.length ?? 0;

  if (euByName.has(nameLower)) {
    const eu = euByName.get(nameLower);
    const usaCfg = extractConfig(agent);
    const euCfg  = extractConfig(eu);
    const diffs  = Object.keys(usaCfg).filter(k => JSON.stringify(usaCfg[k]) !== JSON.stringify(euCfg[k]));
    console.log(`EXACT MATCH | "${name}" (KB docs: ${kbCount})`);
    console.log(`  USA: ${id}`);
    console.log(`  EU:  ${eu.agent_id}`);
    if (diffs.length === 0) {
      console.log(`  Config: IDENTICAL`);
    } else {
      console.log(`  Diffs: ${diffs.join(', ')}`);
    }
  } else {
    let best = null, bestScore = 0;
    for (const eu of euList) {
      const s = sim(name, eu.name ?? '');
      if (s > bestScore) { bestScore = s; best = eu; }
    }
    if (best && bestScore >= 0.75) {
      console.log(`FUZZY MATCH ${Math.round(bestScore*100)}% | USA: "${name}" <-> EU: "${best.name}" (KB docs: ${kbCount})`);
      console.log(`  USA: ${id}`);
      console.log(`  EU:  ${best.agent_id}`);
    } else {
      console.log(`NO MATCH | "${name}" (KB docs: ${kbCount}) → will CREATE in EU`);
      console.log(`  USA: ${id}`);
    }
  }
  console.log();
}
