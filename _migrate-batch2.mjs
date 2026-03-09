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

const USA = { key: env.ELEVENLABS_USA_KEY, url: env.ELEVENLABS_USA_URL };
const EU  = { key: env.ELEVENLABS_EU_KEY,  url: env.ELEVENLABS_EU_URL  };

const TO_CREATE = [
  'agent_3201k7pxmha3fhsawdtavnk1jr27',  // Merck USA Agent #2
  'agent_7301k7pkgrbafxj9tw9ttddebta1',  // OLSO-Yammi
  'agent_7101k7h4favke5zvyh1xznvh1wmt',  // FNOL Demo
  'agent_9201k74968dge7yat0p3vj9hz05a',  // Melia Checkin
  'agent_6801k7256s48ev2vagx1q41eaczy',  // ECI (CREATE new, keep existing EU untouched)
];

async function apiFetch(e, path, opts = {}) {
  const res = await fetch(`${e.url}${path}`, {
    ...opts,
    headers: { 'xi-api-key': e.key, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function migrateKbDoc(doc) {
  if (doc.type === 'text') {
    const res = await fetch(`${EU.url}/v1/convai/knowledge-base/text`, {
      method: 'POST',
      headers: { 'xi-api-key': EU.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: doc.name, text: doc.extracted_inner_html ?? '' }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`KB text → ${res.status}: ${text}`);
    return JSON.parse(text);
  } else {
    const content  = doc.extracted_inner_html ?? '';
    const filename = (doc.filename ?? doc.name).replace(/\.[^.]+$/, '') + '.txt';
    const form = new FormData();
    form.append('name', doc.name);
    form.append('file', new Blob([content], { type: 'text/plain' }), filename);
    const res = await fetch(`${EU.url}/v1/convai/knowledge-base`, {
      method: 'POST', headers: { 'xi-api-key': EU.key }, body: form,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`KB file → ${res.status}: ${text}`);
    return JSON.parse(text);
  }
}

async function migrateKB(kbRefs) {
  if (!kbRefs?.length) return {};
  const idMap = {};
  for (const ref of kbRefs) {
    process.stdout.write(`      KB [${ref.type}] "${ref.name}" ... `);
    try {
      const doc     = await apiFetch(USA, `/v1/convai/knowledge-base/${ref.id}`);
      const created = await migrateKbDoc(doc);
      idMap[ref.id] = created.id;
      console.log(`✓ ${created.id}`);
    } catch (e) {
      console.log(`✗ ${e.message}`);
      idMap[ref.id] = ref.id;
    }
  }
  return idMap;
}

function buildPayload(agent, kbIdMap) {
  const payload = {
    name:                agent.name,
    conversation_config: structuredClone(agent.conversation_config),
    platform_settings:   structuredClone(agent.platform_settings),
    tags:                agent.tags ?? [],
  };

  // Remove voice (workspace-specific)
  if (payload.conversation_config?.tts?.voice_id) {
    delete payload.conversation_config.tts.voice_id;
  }

  // Fix tool_ids conflict at agent level
  if (payload.conversation_config?.agent?.tool_ids && payload.conversation_config?.agent?.tools) {
    delete payload.conversation_config.agent.tool_ids;
  }
  // Fix tool_ids conflict at prompt level
  const prompt = payload.conversation_config?.agent?.prompt;
  if (prompt?.tool_ids && prompt?.tools) {
    delete prompt.tool_ids;
  }

  // Strip account-specific platform fields
  if (payload.platform_settings) {
    delete payload.platform_settings.phone_numbers;
    delete payload.platform_settings.whatsapp_accounts;
  }

  // Remap KB IDs
  const kbRefs = payload.conversation_config?.agent?.prompt?.knowledge_base ?? [];
  if (kbRefs.length && Object.keys(kbIdMap).length) {
    payload.conversation_config.agent.prompt.knowledge_base = kbRefs.map(r => ({
      ...r, id: kbIdMap[r.id] ?? r.id,
    }));
  }

  return payload;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const results = [];

console.log('\n══════════════════════════════════════════');
console.log('  CREATING 5 agents in EU');
console.log('══════════════════════════════════════════');

for (const usaId of TO_CREATE) {
  let agentName = usaId;
  try {
    const agent = await apiFetch(USA, `/v1/convai/agents/${usaId}`);
    agentName = agent.name;
    process.stdout.write(`\n  "${agentName}" ... `);

    const kbRefs = agent.conversation_config?.agent?.prompt?.knowledge_base ?? [];
    let kbIdMap = {};
    if (kbRefs.length) {
      console.log(`\n    Migrating ${kbRefs.length} KB doc(s):`);
      kbIdMap = await migrateKB(kbRefs);
      console.log(`    Waiting 25s for RAG index...`);
      await sleep(25000);
    }

    const payload = buildPayload(agent, kbIdMap);
    const created = await apiFetch(EU, '/v1/convai/agents/create', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const euId = created.agent_id;
    console.log(kbRefs.length ? `  ✓ CREATED ${euId} (⚠ voice must be set manually)` : `✓ CREATED ${euId} (⚠ voice must be set manually)`);
    results.push({ name: agentName, usaId, euId, ok: true, kbCount: kbRefs.length });
  } catch (e) {
    console.log(`✗ FAILED: ${e.message}`);
    results.push({ name: agentName, usaId, euId: null, ok: false, error: e.message });
  }
}

console.log('\n══════════════════════════════════════════');
console.log('  FINAL MAPPING');
console.log('══════════════════════════════════════════');
for (const r of results) {
  const icon = r.ok ? '✓' : '✗';
  console.log(`  ${icon} "${r.name}"\n    USA: ${r.usaId}\n    EU:  ${r.euId ?? '—'}${r.kbCount ? ` (${r.kbCount} KB docs)` : ''}${r.error ? '\n    ERR: '+r.error : ''}`);
}
