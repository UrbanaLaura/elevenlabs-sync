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

// KB docs already uploaded to EU in previous run — just need to attach them once indexed
const ALREADY_UPLOADED_KB = {
  'agent_3201k7pxmha3fhsawdtavnk1jr27': { // Merck USA Agent #2
    euKbIds: ['pNkUJhUhFFbefwfmlc1k', 'Zzs9oP0bjy31OHY2i0kq', 'xqSw2wPxttckHXNTfEnt'],
  },
  'agent_7301k7pkgrbafxj9tw9ttddebta1': { // OLSO-Yammi
    euKbIds: ['xTqAIO6XXIeWYDP6iGbu', '6gh57Nv0rmICBdBXNf47', 'EVzgQrsnn4QzeDCAnWvY',
              'ytTN5TKVyPdkay9X4FiZ', 'ANC77zkNUVUEVeOr2uTR', 'NgsWgoX519EZ3QrTSMZ0',
              'IRhgWI9TZGOtE6cLZRv2', 'OChT86fm50aB6bcnTQMR'],
  },
  'agent_6801k7256s48ev2vagx1q41eaczy': { // ECI
    euKbIds: ['Ee4sEyhZ5R3sN20OtSSL', 'c5I2asqEniOrjBMmITXF', 'JbqvrAtLywBfpmHSguwx',
              'Yi357BCd01TpEDoMiV8O', 'eV9WfCgSgGQ5E5d5isPs', 'dHuFz7aLPaEEVi5V6sDV',
              'PAXbTDEAIRtPdCTgVviQ', '7mNZwpPRhhId4IyULC9B'],
  },
};

async function apiFetch(e, path, opts = {}) {
  const res = await fetch(`${e.url}${path}`, {
    ...opts,
    headers: { 'xi-api-key': e.key, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

function buildPayload(agent) {
  const payload = {
    name:                agent.name,
    conversation_config: structuredClone(agent.conversation_config),
    platform_settings:   structuredClone(agent.platform_settings),
    tags:                agent.tags ?? [],
  };

  if (payload.conversation_config?.tts?.voice_id) {
    delete payload.conversation_config.tts.voice_id;
  }
  if (payload.conversation_config?.agent?.tool_ids && payload.conversation_config?.agent?.tools) {
    delete payload.conversation_config.agent.tool_ids;
  }
  const prompt = payload.conversation_config?.agent?.prompt;
  if (prompt?.tool_ids && prompt?.tools) delete prompt.tool_ids;

  if (payload.platform_settings) {
    delete payload.platform_settings.phone_numbers;
    delete payload.platform_settings.whatsapp_accounts;
  }

  // Create without KB — RAG not ready, will add manually
  if (prompt) prompt.knowledge_base = [];

  return payload;
}

const FAILED = [
  'agent_3201k7pxmha3fhsawdtavnk1jr27',  // Merck USA Agent #2
  'agent_7301k7pkgrbafxj9tw9ttddebta1',  // OLSO-Yammi
  'agent_6801k7256s48ev2vagx1q41eaczy',  // ECI
];

const results = [];

console.log('\n══════════════════════════════════════════');
console.log('  CREATING 3 agents without KB (RAG not ready)');
console.log('══════════════════════════════════════════');

for (const usaId of FAILED) {
  let agentName = usaId;
  try {
    const agent = await apiFetch(USA, `/v1/convai/agents/${usaId}`);
    agentName = agent.name;
    process.stdout.write(`\n  "${agentName}" ... `);

    const payload = buildPayload(agent);
    const created = await apiFetch(EU, '/v1/convai/agents/create', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const euId = created.agent_id;
    const kbInfo = ALREADY_UPLOADED_KB[usaId];
    console.log(`✓ CREATED ${euId} (⚠ voice + KB must be set manually)`);
    results.push({ name: agentName, usaId, euId, ok: true, euKbIds: kbInfo?.euKbIds ?? [] });
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
  console.log(`  ${icon} "${r.name}"\n    USA: ${r.usaId}\n    EU:  ${r.euId ?? '—'}${r.error ? '\n    ERR: '+r.error : ''}`);
  if (r.euKbIds?.length) {
    console.log(`    ⚠ KB docs uploaded (add manually in EU dashboard):`);
    r.euKbIds.forEach(id => console.log(`      - ${id}`));
  }
}
