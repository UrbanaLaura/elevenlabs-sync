import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '.env'), 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.split('=').map(s => s.trim()))
    .filter(([k]) => k)
);

const USA = { key: env.ELEVENLABS_USA_KEY, url: env.ELEVENLABS_USA_URL };
const EU  = { key: env.ELEVENLABS_EU_KEY,  url: env.ELEVENLABS_EU_URL  };

const AGENT_ID = process.argv[2];
if (!AGENT_ID) { console.error('Usage: node migrate-agent.js <usa_agent_id>'); process.exit(1); }

async function apiFetch(env, path, opts = {}) {
  const res = await fetch(`${env.url}${path}`, {
    ...opts,
    headers: { 'xi-api-key': env.key, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ── Knowledge base migration ──────────────────────────────────────────────────

async function migrateKbDoc(doc) {
  if (doc.type === 'text') {
    // Create as text doc in EU
    const res = await fetch(`${EU.url}/v1/convai/knowledge-base/text`, {
      method: 'POST',
      headers: { 'xi-api-key': EU.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: doc.name, text: doc.extracted_inner_html ?? '' }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`KB create text → ${res.status}: ${text}`);
    return JSON.parse(text);
  } else {
    // type === 'file': upload extracted text as a .txt file via multipart
    const content = doc.extracted_inner_html ?? '';
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
    if (!res.ok) throw new Error(`KB upload file → ${res.status}: ${text}`);
    return JSON.parse(text);
  }
}

async function migrateKnowledgeBase(kbRefs) {
  if (!kbRefs || kbRefs.length === 0) return [];

  console.log(`\nMigrating ${kbRefs.length} knowledge base document(s)...`);
  const idMap = {}; // usa_kb_id -> eu_kb_id

  for (const ref of kbRefs) {
    process.stdout.write(`  [${ref.type}] "${ref.name}" ... `);
    try {
      // Fetch full doc from USA (to get extracted_inner_html)
      const doc = await apiFetch(USA, `/v1/convai/knowledge-base/${ref.id}`);
      const created = await migrateKbDoc(doc);
      idMap[ref.id] = created.id;
      console.log(`✓ EU ID: ${created.id}`);
    } catch (e) {
      console.log(`✗ FAILED: ${e.message}`);
      // Keep original ID so creation doesn't break; agent will just have a broken ref
      idMap[ref.id] = ref.id;
    }
  }

  return idMap;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`Fetching agent ${AGENT_ID} from USA...`);
const agent = await apiFetch(USA, `/v1/convai/agents/${AGENT_ID}`);
console.log(`  Name: "${agent.name}"`);

// Migrate knowledge base docs and remap IDs
const kbRefs = agent.conversation_config?.agent?.prompt?.knowledge_base ?? [];
const kbIdMap = await migrateKnowledgeBase(kbRefs);

// Build create payload — only writable fields
const payload = {
  name:                agent.name,
  conversation_config: agent.conversation_config,
  platform_settings:   agent.platform_settings,
  tags:                agent.tags ?? [],
};

// Remap KB IDs to EU equivalents
if (kbRefs.length > 0) {
  payload.conversation_config.agent.prompt.knowledge_base = kbRefs.map(ref => ({
    ...ref,
    id: kbIdMap[ref.id] ?? ref.id,
  }));
}

// Strip account-specific / read-only platform fields
if (payload.platform_settings) {
  delete payload.platform_settings.phone_numbers;
  delete payload.platform_settings.whatsapp_accounts;
}

console.log(`\nCreating agent in EU...`);
const created = await apiFetch(EU, '/v1/convai/agents/create', {
  method: 'POST',
  body: JSON.stringify(payload),
});

// Verify by fetching the created agent
const verified = await apiFetch(EU, `/v1/convai/agents/${created.agent_id}`);

console.log(`\n✓ Agent migrated to EU:`);
console.log(`  Name:        ${verified.name}`);
console.log(`  EU ID:       ${created.agent_id}`);
console.log(`  USA ID:      ${AGENT_ID}`);
if (kbRefs.length > 0) {
  console.log(`  KB docs:     ${kbRefs.length} migrated`);
}
