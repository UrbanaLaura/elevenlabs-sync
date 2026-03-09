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

// ── Agents to PATCH (exist in EU but empty) ───────────────────────────────────
const TO_PATCH = [
  { usaId: 'agent_8301k62q3x7xer3a4xcwafz65rjz', euId: 'agent_4301kjpr1z5dfspsp2142xv21925', name: 'Allianz-Agent-widget' },
  { usaId: 'agent_4201k62pce3jew880b61vgk68x0q', euId: 'agent_0801kjpq8kjcfgmvh2pxnrgk028q', name: 'Iberdrola-Agent-widget' },
  { usaId: 'agent_8601k56chfrrewqr8mq3ws036jd4', euId: 'agent_5901k56fpd6vejjap4wpqxb735h8', name: 'Merck USA Agent' },
  { usaId: 'agent_3101k49rwfjperxsgyrvq8c2jy7f', euId: 'agent_2201kjprnnewedvth3h66wbxf7nj', name: 'dsm-firmenich' },
  { usaId: 'agent_01jyp9grq6fxf8wjt372n89sp2',   euId: 'agent_0801kjq2rqrbe3jtvscn00kps040', name: 'EDP' },
];

// ── Agents to CREATE in EU (no match found) ───────────────────────────────────
const TO_CREATE = [
  'agent_5301k6g4fraaed48wc21846hny46',  // conEdison USA Agent
  'agent_4501k6dms10qftr8am3rkgjv3sfe',  // Cloud Guru
  'agent_1501k5v36n63fdm870vb00gdeqph',  // OLSO-Santander
  'agent_9901k5epyvj3fk2seefa5pn0pze4',  // Iberdrola-demo
  'agent_3701k5bmgcztfa89dzjrgdehmgsg',  // Cupra-demo
  'agent_0801k4s4cjv9e0y9nkdcr2w8r1fs',  // OLSO-vinos
  'agent_01jzw6kzrdfq3b7d325h27xh5d',    // Grupo Ruiz
  'agent_01jzmfzpxmewcaq7gzrq3jqnn6',    // Neste - RFP Agent
  'agent_01jzafdg1pespt69gpnd74jcg2',    // Raval Voice - Sales Trainer
  'agent_01jz7g9pavftn93s8wfhz8rjkt',    // Novartis
  'agent_01jz2bc8dqe3evhhfdj175e7j8',    // Luis Riu
  'agent_01jxfp5g37f1ka3nybnwzevcp4',    // BusinessKPI
  'agent_01jwdfqtpfftdsgdpeg50ttd15',    // Deutsche Bank
  'ZwZb8bPj7HFKnYqKkhLZ',               // Sofía_Profesora Digital
];

// ── Helpers ───────────────────────────────────────────────────────────────────
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
      method: 'POST',
      headers: { 'xi-api-key': EU.key },
      body: form,
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
  if (payload.platform_settings) {
    delete payload.platform_settings.phone_numbers;
    delete payload.platform_settings.whatsapp_accounts;
  }
  const kbRefs = payload.conversation_config?.agent?.prompt?.knowledge_base ?? [];
  if (kbRefs.length && Object.keys(kbIdMap).length) {
    payload.conversation_config.agent.prompt.knowledge_base = kbRefs.map(r => ({
      ...r, id: kbIdMap[r.id] ?? r.id,
    }));
  }
  return payload;
}

// ── Results table ─────────────────────────────────────────────────────────────
const results = [];

// ── 1. PATCH existing EU agents ───────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log('  PATCHING 5 existing EU agents');
console.log('══════════════════════════════════════════');

for (const { usaId, euId, name } of TO_PATCH) {
  process.stdout.write(`\n  "${name}" ... `);
  try {
    const agent  = await apiFetch(USA, `/v1/convai/agents/${usaId}`);
    const kbRefs = agent.conversation_config?.agent?.prompt?.knowledge_base ?? [];
    const kbIdMap = kbRefs.length ? await (async () => {
      console.log(`\n    Migrating ${kbRefs.length} KB doc(s):`);
      return migrateKB(kbRefs);
    })() : {};

    const payload = buildPayload(agent, kbIdMap);
    await apiFetch(EU, `/v1/convai/agents/${euId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    console.log(kbRefs.length ? `  ✓ PATCHED` : `✓ PATCHED`);
    results.push({ action: 'PATCH', name, usaId, euId });
  } catch (e) {
    console.log(`✗ FAILED: ${e.message}`);
    results.push({ action: 'PATCH', name, usaId, euId, error: e.message });
  }
}

// ── 2. CREATE new agents in EU ────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log('  CREATING 14 new agents in EU');
console.log('══════════════════════════════════════════');

for (const usaId of TO_CREATE) {
  let agentName = usaId;
  try {
    const agent  = await apiFetch(USA, `/v1/convai/agents/${usaId}`);
    agentName    = agent.name;
    process.stdout.write(`\n  "${agentName}" ... `);

    const kbRefs  = agent.conversation_config?.agent?.prompt?.knowledge_base ?? [];
    const kbIdMap = kbRefs.length ? await (async () => {
      console.log(`\n    Migrating ${kbRefs.length} KB doc(s):`);
      return migrateKB(kbRefs);
    })() : {};

    const payload = buildPayload(agent, kbIdMap);
    const created = await apiFetch(EU, '/v1/convai/agents/create', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    console.log(kbRefs.length ? `  ✓ CREATED ${created.agent_id}` : `✓ CREATED ${created.agent_id}`);
    results.push({ action: 'CREATE', name: agentName, usaId, euId: created.agent_id });
  } catch (e) {
    console.log(`✗ FAILED: ${e.message}`);
    results.push({ action: 'CREATE', name: agentName, usaId, euId: null, error: e.message });
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log('  MAPPING: USA ID → EU ID');
console.log('══════════════════════════════════════════');
for (const r of results) {
  const status = r.error ? '✗ FAILED' : (r.action === 'PATCH' ? '✓ PATCHED' : '✓ CREATED');
  console.log(`  ${status} | "${r.name}"`);
  console.log(`    USA: ${r.usaId}`);
  console.log(`    EU:  ${r.euId ?? '—'}`);
  if (r.error) console.log(`    ERR: ${r.error}`);
}
