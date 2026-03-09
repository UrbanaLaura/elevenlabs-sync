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

// All failed agents from first run
// action: 'patch' = update existing EU agent (empty shell), 'create' = new
const FAILED = [
  { usaId: 'agent_4201k62pce3jew880b61vgk68x0q', name: 'Iberdrola-Agent-widget', euId: 'agent_0801kjpq8kjcfgmvh2pxnrgk028q', action: 'patch'  },
  { usaId: 'agent_3101k49rwfjperxsgyrvq8c2jy7f', name: 'dsm-firmenich',          euId: 'agent_2201kjprnnewedvth3h66wbxf7nj', action: 'patch'  },
  { usaId: 'agent_01jyp9grq6fxf8wjt372n89sp2',  name: 'EDP',                    euId: 'agent_0801kjq2rqrbe3jtvscn00kps040', action: 'patch'  },
  { usaId: 'agent_4501k6dms10qftr8am3rkgjv3sfe', name: 'Cloud Guru',            euId: null, action: 'create' },
  { usaId: 'agent_1501k5v36n63fdm870vb00gdeqph', name: 'OLSO-Santander',        euId: null, action: 'create' },
  { usaId: 'agent_3701k5bmgcztfa89dzjrgdehmgsg', name: 'Cupra-demo',            euId: null, action: 'create' },
  { usaId: 'agent_01jzw6kzrdfq3b7d325h27xh5d',  name: 'Grupo Ruiz',            euId: null, action: 'create' },
  { usaId: 'agent_01jzmfzpxmewcaq7gzrq3jqnn6',  name: 'Neste - RFP Agent',     euId: null, action: 'create' },
  { usaId: 'agent_01jz7g9pavftn93s8wfhz8rjkt',  name: 'Novartis',              euId: null, action: 'create' },
  { usaId: 'agent_01jz2bc8dqe3evhhfdj175e7j8',  name: 'Luis Riu',              euId: null, action: 'create' },
  { usaId: 'agent_01jxfp5g37f1ka3nybnwzevcp4',  name: 'BusinessKPI',           euId: null, action: 'create' },
  { usaId: 'agent_01jwdfqtpfftdsgdpeg50ttd15',  name: 'Deutsche Bank',         euId: null, action: 'create' },
  { usaId: 'ZwZb8bPj7HFKnYqKkhLZ',             name: 'Sofía_Profesora Digital',euId: null, action: 'create' },
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

async function uploadKbDoc(doc) {
  if (doc.type === 'text') {
    const res = await fetch(`${EU.url}/v1/convai/knowledge-base/text`, {
      method: 'POST',
      headers: { 'xi-api-key': EU.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: doc.name, text: doc.extracted_inner_html ?? '' }),
    });
    const t = await res.text();
    if (!res.ok) throw new Error(`KB text → ${res.status}: ${t}`);
    return JSON.parse(t);
  } else {
    const form = new FormData();
    form.append('name', doc.name);
    form.append('file', new Blob([doc.extracted_inner_html ?? ''], { type: 'text/plain' }),
      (doc.filename ?? doc.name).replace(/\.[^.]+$/, '') + '.txt');
    const res = await fetch(`${EU.url}/v1/convai/knowledge-base`, {
      method: 'POST', headers: { 'xi-api-key': EU.key }, body: form,
    });
    const t = await res.text();
    if (!res.ok) throw new Error(`KB file → ${res.status}: ${t}`);
    return JSON.parse(t);
  }
}

async function migrateKB(kbRefs) {
  const idMap = {};
  for (const ref of kbRefs) {
    process.stdout.write(`      KB "${ref.name}" ... `);
    try {
      const doc     = await apiFetch(USA, `/v1/convai/knowledge-base/${ref.id}`);
      const created = await uploadKbDoc(doc);
      idMap[ref.id] = created.id;
      console.log(`✓ ${created.id}`);
    } catch (e) {
      console.log(`✗ ${e.message}`);
      idMap[ref.id] = ref.id;
    }
  }
  return idMap;
}

const results = [];

for (const r of FAILED) {
  console.log(`\n  "${r.name}" ...`);
  try {
    const agent = await apiFetch(USA, `/v1/convai/agents/${r.usaId}`);
    const kbRefs = agent.conversation_config?.agent?.prompt?.knowledge_base ?? [];

    // Migrate KB docs
    let kbIdMap = {};
    if (kbRefs.length) {
      console.log(`    Migrating ${kbRefs.length} KB doc(s):`);
      kbIdMap = await migrateKB(kbRefs);
      // Wait for RAG indexing
      console.log(`    Waiting 20s for RAG index...`);
      await sleep(20000);
    }

    // Build payload
    const payload = {
      name:                agent.name,
      conversation_config: structuredClone(agent.conversation_config),
      platform_settings:   structuredClone(agent.platform_settings),
      tags:                agent.tags ?? [],
    };

    // Fix: remove voice_id (not available in EU workspace)
    if (payload.conversation_config?.tts?.voice_id) {
      delete payload.conversation_config.tts.voice_id;
    }

    // Fix: remove tool_ids if tools array also present (conflict)
    if (payload.conversation_config?.agent?.tool_ids && payload.conversation_config?.agent?.tools) {
      delete payload.conversation_config.agent.tool_ids;
    }

    // Strip account-specific platform fields
    if (payload.platform_settings) {
      delete payload.platform_settings.phone_numbers;
      delete payload.platform_settings.whatsapp_accounts;
    }

    // Remap KB IDs
    if (kbRefs.length) {
      payload.conversation_config.agent.prompt.knowledge_base = kbRefs.map(ref => ({
        ...ref, id: kbIdMap[ref.id] ?? ref.id,
      }));
    }

    let euId = r.euId;
    if (r.action === 'patch') {
      await apiFetch(EU, `/v1/convai/agents/${euId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      console.log(`  ✓ PATCHED ${euId} (⚠ voice must be set manually)`);
    } else {
      const created = await apiFetch(EU, '/v1/convai/agents/create', { method: 'POST', body: JSON.stringify(payload) });
      euId = created.agent_id;
      console.log(`  ✓ CREATED ${euId} (⚠ voice must be set manually)`);
    }
    results.push({ name: r.name, usaId: r.usaId, euId, ok: true });
  } catch (e) {
    console.log(`  ✗ FAILED: ${e.message}`);
    results.push({ name: r.name, usaId: r.usaId, euId: r.euId, ok: false, error: e.message });
  }
}

console.log('\n══════════════════════════════════════════');
console.log('  FINAL MAPPING');
console.log('══════════════════════════════════════════');
for (const r of results) {
  const icon = r.ok ? '✓' : '✗';
  console.log(`  ${icon} "${r.name}"\n    USA: ${r.usaId}\n    EU:  ${r.euId ?? '—'}${r.error ? '\n    ERR: '+r.error : ''}`);
}
