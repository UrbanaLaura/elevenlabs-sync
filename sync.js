import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env manually (no dotenv dependency)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.split('=').map(s => s.trim()))
    .filter(([k]) => k)
);

const USA = { key: env.ELEVENLABS_USA_KEY, url: env.ELEVENLABS_USA_URL, name: 'USA' };
const EU  = { key: env.ELEVENLABS_EU_KEY,  url: env.ELEVENLABS_EU_URL,  name: 'EU'  };

// ── API helpers ──────────────────────────────────────────────────────────────

async function apiFetch(env, path) {
  const res = await fetch(`${env.url}${path}`, {
    headers: { 'xi-api-key': env.key, 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[${env.name}] ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function listAgents(env) {
  let agents = [];
  let cursor = null;
  while (true) {
    const qs = cursor ? `?cursor=${cursor}&page_size=100` : '?page_size=100';
    const data = await apiFetch(env, `/v1/convai/agents${qs}`);
    agents = agents.concat(data.agents ?? []);
    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return agents;
}

async function getAgent(env, agentId) {
  return apiFetch(env, `/v1/convai/agents/${agentId}`);
}

// ── Fuzzy matching ───────────────────────────────────────────────────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function similarity(a, b) {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

// ── Config diff ──────────────────────────────────────────────────────────────

function hasWidgetCustomization(agent) {
  const w = agent.platform_settings?.widget;
  if (!w) return false;
  const visualFields = ['bg_color', 'text_color', 'btn_color', 'btn_text_color',
    'border_color', 'focus_color', 'action_text', 'start_call_text', 'end_call_text',
    'expand_text', 'styles', 'custom_avatar_path'];
  return visualFields.some(f => w[f] != null && w[f] !== '');
}

function extractRelevantConfig(agent) {
  return {
    name:          agent.name ?? null,
    system_prompt: agent.conversation_config?.agent?.prompt?.prompt ?? null,
    first_message: agent.conversation_config?.agent?.first_message ?? null,
    voice_id:      agent.conversation_config?.tts?.voice_id ?? null,
    widget_customized: hasWidgetCustomization(agent),
  };
}

function compareConfigs(usaAgent, euAgent) {
  const usa = extractRelevantConfig(usaAgent);
  const eu  = extractRelevantConfig(euAgent);
  const diffs = [];
  for (const field of Object.keys(usa)) {
    if (JSON.stringify(usa[field]) !== JSON.stringify(eu[field])) {
      diffs.push(field);
    }
  }
  return { usa_config: usa, eu_config: eu, diff_fields: diffs };
}

// Keep backward-compat alias used in confirmed-match path
function filteredDiff(usaAgent, euAgent) {
  const { diff_fields, usa_config, eu_config } = compareConfigs(usaAgent, euAgent);
  return diff_fields.map(field => ({ field, usa: usa_config[field], eu: eu_config[field] }));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function fetchAllAgents(env) {
  console.log(`\n[${env.name}] Listing agents...`);
  const list = await listAgents(env);
  console.log(`[${env.name}] Found ${list.length} agents. Fetching full configs...`);

  const agents = [];
  for (let i = 0; i < list.length; i++) {
    const agent = list[i];
    process.stdout.write(`\r[${env.name}] ${i + 1}/${list.length} — ${agent.name.slice(0, 50).padEnd(50)}`);
    try {
      const full = await getAgent(env, agent.agent_id);
      agents.push(full);
    } catch (e) {
      console.error(`\n[${env.name}] Error fetching ${agent.agent_id}: ${e.message}`);
      agents.push({ ...agent, _fetch_error: e.message });
    }
  }
  console.log(`\n[${env.name}] Done.`);
  return agents;
}

function loadConfirmed() {
  const file = join(__dirname, 'confirmed_matches.json');
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8'));
}

function buildMigrationMap(usaAgents, euAgents) {
  const POSSIBLE_THRESHOLD = 0.75;

  // Apply manually confirmed matches first
  const confirmed = loadConfirmed();
  const confirmedByUsaId = new Map(confirmed.map(c => [c.usa_agent_id, c]));

  // Index EU by lowercased name for fast exact lookup
  const euByName = new Map(euAgents.map(a => [a.name.toLowerCase().trim(), a]));

  const matched = new Set(); // EU agent_ids already matched

  const results = usaAgents.map(usaAgent => {
    const usaName = usaAgent.name?.toLowerCase().trim() ?? '';

    // 0. Confirmed match (manually approved via dashboard)
    if (confirmedByUsaId.has(usaAgent.agent_id)) {
      const c = confirmedByUsaId.get(usaAgent.agent_id);
      const euAgent = euAgents.find(a => a.agent_id === c.eu_agent_id);
      if (euAgent) {
        matched.add(euAgent.agent_id);
        const { usa_config, eu_config, diff_fields } = compareConfigs(usaAgent, euAgent);
        return {
          status: diff_fields.length === 0 ? 'MIGRATED_IDENTICAL' : 'MIGRATED_WITH_DIFFS',
          usa_name: usaAgent.name,
          eu_name: euAgent.name,
          usa_agent_id: usaAgent.agent_id,
          eu_agent_id: euAgent.agent_id,
          diff_fields,
          usa_config,
          eu_config,
          confirmed: true,
        };
      }
    }

    // 1. Exact match
    if (euByName.has(usaName)) {
      const euAgent = euByName.get(usaName);
      matched.add(euAgent.agent_id);
      const { usa_config, eu_config, diff_fields } = compareConfigs(usaAgent, euAgent);
      return {
        status: diff_fields.length === 0 ? 'MIGRATED_IDENTICAL' : 'MIGRATED_WITH_DIFFS',
        usa_name: usaAgent.name,
        eu_name: euAgent.name,
        usa_agent_id: usaAgent.agent_id,
        eu_agent_id: euAgent.agent_id,
        diff_fields,
        usa_config,
        eu_config,
      };
    }

    // 2. Fuzzy match — find best candidate
    let best = null;
    let bestScore = 0;
    for (const euAgent of euAgents) {
      if (matched.has(euAgent.agent_id)) continue;
      const score = similarity(usaAgent.name ?? '', euAgent.name ?? '');
      if (score > bestScore) { bestScore = score; best = euAgent; }
    }

    if (best && bestScore >= POSSIBLE_THRESHOLD) {
      const { usa_config, eu_config, diff_fields } = compareConfigs(usaAgent, best);
      return {
        status: 'POSSIBLE_MATCH',
        similarity_score: Math.round(bestScore * 100) / 100,
        usa_name: usaAgent.name,
        eu_name: best.name,
        usa_agent_id: usaAgent.agent_id,
        eu_agent_id: best.agent_id,
        diff_fields,
        usa_config,
        eu_config,
      };
    }

    // 3. Not migrated
    return {
      status: 'NOT_MIGRATED',
      usa_name: usaAgent.name,
      usa_agent_id: usaAgent.agent_id,
    };
  });

  // Agents in EU that have no USA counterpart
  const orphanEU = euAgents.filter(a => !matched.has(a.agent_id) && !results.some(r =>
    r.eu_agent_id === a.agent_id
  ));

  return { usa_to_eu: results, eu_only: orphanEU.map(a => ({ agent_id: a.agent_id, name: a.name })) };
}

function printSummary(map) {
  const counts = {};
  for (const r of map.usa_to_eu) counts[r.status] = (counts[r.status] ?? 0) + 1;

  console.log('\n════════════════════════════════════════════');
  console.log('  MIGRATION REPORT SUMMARY');
  console.log('════════════════════════════════════════════');
  console.log(`  MIGRATED (identical):    ${counts.MIGRATED_IDENTICAL ?? 0}`);
  console.log(`  MIGRATED (with diffs):   ${counts.MIGRATED_WITH_DIFFS ?? 0}`);
  console.log(`  POSSIBLE MATCH (review): ${counts.POSSIBLE_MATCH ?? 0}`);
  console.log(`  NOT MIGRATED:            ${counts.NOT_MIGRATED ?? 0}`);
  console.log(`  EU-only (no USA source): ${map.eu_only.length}`);
  console.log('════════════════════════════════════════════');

  if (counts.MIGRATED_WITH_DIFFS > 0) {
    console.log('\n  Agents migrated but with config differences:');
    map.usa_to_eu
      .filter(r => r.status === 'MIGRATED_WITH_DIFFS')
      .forEach(r => console.log(`    - "${r.usa_name}" (${r.diff_fields?.length ?? 0} diffs)`));
  }

  if (counts.POSSIBLE_MATCH > 0) {
    console.log('\n  Possible matches (confirm manually):');
    map.usa_to_eu
      .filter(r => r.status === 'POSSIBLE_MATCH')
      .forEach(r => console.log(`    - USA: "${r.usa_name}" <-> EU: "${r.eu_name}" (${Math.round(r.similarity_score * 100)}% similar, ${r.diff_fields?.length ?? 0} diffs)`));
  }

  if (counts.NOT_MIGRATED > 0) {
    console.log('\n  Not yet migrated:');
    map.usa_to_eu
      .filter(r => r.status === 'NOT_MIGRATED')
      .forEach(r => console.log(`    - "${r.usa_name}"`));
  }

  if (map.eu_only.length > 0) {
    console.log('\n  EU-only agents (no source in USA):');
    map.eu_only.forEach(a => console.log(`    - "${a.name}"`));
  }
}

async function main() {
  const outputDir = join(__dirname, 'output');
  mkdirSync(outputDir, { recursive: true });

  const [usaAgents, euAgents] = await Promise.all([
    fetchAllAgents(USA),
    fetchAllAgents(EU),
  ]);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const usaFile = join(outputDir, `usa_backup_${timestamp}.json`);
  const euFile  = join(outputDir, `eu_inventory_${timestamp}.json`);

  writeFileSync(usaFile, JSON.stringify(usaAgents, null, 2));
  writeFileSync(euFile,  JSON.stringify(euAgents,  null, 2));
  console.log(`\nBackups saved:`);
  console.log(`  USA: ${usaFile}`);
  console.log(`  EU:  ${euFile}`);

  console.log('\nBuilding migration map...');
  const map = buildMigrationMap(usaAgents, euAgents);

  const mapFile = join(outputDir, `migration_map_${timestamp}.json`);
  writeFileSync(mapFile, JSON.stringify(map, null, 2));
  console.log(`  Map: ${mapFile}`);

  printSummary(map);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
