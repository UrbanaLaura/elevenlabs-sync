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
  'agent_9601k2ehgvjwe7tvft51fvycv9ve',  // Scottish Water Agent
  'agent_2101k2egr1ryfd188w5x88pegza1',  // DB Agent
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function buildPayload(agent, kbIdMap, emptyKb = false) {
  const payload = {
    name:                agent.name,
    conversation_config: structuredClone(agent.conversation_config),
    platform_settings:   structuredClone(agent.platform_settings),
    tags:                agent.tags ?? [],
  };
  if (payload.conversation_config?.tts?.voice_id) delete payload.conversation_config.tts.voice_id;
  if (payload.conversation_config?.agent?.tool_ids && payload.conversation_config?.agent?.tools)
    delete payload.conversation_config.agent.tool_ids;
  const prompt = payload.conversation_config?.agent?.prompt;
  if (prompt?.tool_ids && prompt?.tools) delete prompt.tool_ids;
  if (payload.platform_settings) {
    delete payload.platform_settings.phone_numbers;
    delete payload.platform_settings.whatsapp_accounts;
  }
  if (emptyKb && prompt) {
    prompt.knowledge_base = [];
  } else if (prompt) {
    const kbRefs = prompt.knowledge_base ?? [];
    if (kbRefs.length && Object.keys(kbIdMap).length) {
      prompt.knowledge_base = kbRefs.map(r => ({ ...r, id: kbIdMap[r.id] ?? r.id }));
    }
  }
  return payload;
}

const results = [];

console.log('\n══════════════════════════════════════════');
console.log('  CREATING 2 agents in EU');
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
      console.log(`    Waiting 30s for RAG index...`);
      await sleep(30000);
    }

    // Try with KB first
    let payload = buildPayload(agent, kbIdMap, false);
    let euId;
    try {
      const created = await apiFetch(EU, '/v1/convai/agents/create', { method: 'POST', body: JSON.stringify(payload) });
      euId = created.agent_id;
      console.log(kbRefs.length ? `  ✓ CREATED ${euId} with KB (⚠ voice must be set manually)` : `✓ CREATED ${euId} (⚠ voice must be set manually)`);
      results.push({ name: agentName, usaId, euId, ok: true, kbCount: kbRefs.length, kbMissing: false });
    } catch (e) {
      if (e.message.includes('rag_index_not_ready') && kbRefs.length) {
        console.log(`\n    RAG not ready — creating without KB...`);
        payload = buildPayload(agent, kbIdMap, true);
        const created = await apiFetch(EU, '/v1/convai/agents/create', { method: 'POST', body: JSON.stringify(payload) });
        euId = created.agent_id;
        const euKbIds = Object.values(kbIdMap).filter(id => !Object.keys(kbIdMap).includes(id));
        console.log(`  ✓ CREATED ${euId} (⚠ voice + KB must be set manually)`);
        results.push({ name: agentName, usaId, euId, ok: true, kbCount: kbRefs.length, kbMissing: true, euKbIds: Object.values(kbIdMap) });
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.log(`✗ FAILED: ${e.message}`);
    results.push({ name: agentName, usaId, euId: null, ok: false, error: e.message });
  }
}

console.log('\n══════════════════════════════════════════');
console.log('  FINAL MAPPING');
console.log('══════════════════════════════════════════');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} "${r.name}"\n    USA: ${r.usaId}\n    EU:  ${r.euId ?? '—'}${r.error ? '\n    ERR: '+r.error : ''}`);
  if (r.kbMissing && r.euKbIds?.length) {
    console.log(`    ⚠ KB docs uploaded, add manually: ${r.euKbIds.join(', ')}`);
  }
}
