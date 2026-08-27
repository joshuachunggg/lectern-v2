import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('cloud worker uses OpenAI APIs and no local database', async () => {
  const worker = await readFile('supabase/functions/process-lecture/index.ts', 'utf8');
  assert.match(worker, /\/audio\/transcriptions/);
  assert.match(worker, /gpt-transcribe/);
  assert.match(worker, /\/responses/);
  assert.match(worker, /estimated_cost_usd/);
  assert.match(worker, /max_output_tokens: 12000/);
  assert.match(worker, /User note preferences/);
  assert.match(worker, /synthesize_only/);
  assert.match(worker, /synthesize_only && source\.source_type === 'audio'/);
  assert.match(worker, /part\.type === 'output_text'/);
  assert.match(worker, /Note synthesis returned no text/);
  assert.match(worker, /TRANSCRIPTION_PROVIDER/);
  assert.match(worker, /whisper-large-v3/);
  assert.doesNotMatch(worker, /sqlite|codex exec/i);
});

test('new lectures save optional note preferences', async () => {
  const app = await readFile('src.tsx', 'utf8');
  const migration = await readFile(
    'supabase/migrations/20260826000001_add_synthesis_prompt.sql',
    'utf8',
  );
  assert.match(app, /synthesis_prompt: notePrompt\.trim\(\)/);
  assert.match(app, /id="note-prompt"/);
  assert.match(app, /Redo AI synthesis/);
  assert.match(app, /synthesize_only: synthesizeOnly/);
  assert.match(app, /Add additional content/);
  assert.match(app, /function openPrompt\(session: Lecture \| null\)/);
  assert.match(app, /from\("saved_prompts"\)/);
  assert.doesNotMatch(app, /Paste transcript/);
  assert.doesNotMatch(app, /Estimated API cost/);
  assert.match(migration, /synthesis_prompt/);
});

test('saved prompts are private to the signed-in user', async () => {
  const migration = await readFile(
    'supabase/migrations/20260826000002_add_saved_prompts.sql',
    'utf8',
  );
  assert.match(migration, /create table public\.saved_prompts/);
  assert.match(migration, /owner_id uuid not null/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /owner_id = auth\.uid\(\)/);
});

test('edge function accepts browser CORS preflights', async () => {
  const worker = await readFile('supabase/functions/process-lecture/index.ts', 'utf8');
  assert.match(worker, /Access-Control-Allow-Origin/);
  assert.match(worker, /request\.method === 'OPTIONS'/);
});

test('saved sessions can be deleted with their uploaded source files', async () => {
  const app = await readFile('src.tsx', 'utf8');
  assert.match(app, /async function deleteLecture/);
  assert.match(app, /from\("lecture-files"\)\.remove\(paths\)/);
  assert.match(app, /from\("lectures"\)\.delete\(\)\.eq\("id", session\.id\)/);
  assert.match(app, /aria-label=\{`Delete \$\{session\.title\}`\}/);
});

test('billing and source limits are enforced before model work starts', async () => {
  const worker = await readFile('supabase/functions/process-lecture/index.ts', 'utf8');
  const billing = await readFile('supabase/functions/billing/index.ts', 'utf8');
  const app = await readFile('src.tsx', 'utf8');
  const migration = await readFile('supabase/migrations/20260826000003_add_billing.sql', 'utf8');
  const materialLimit = await readFile('supabase/migrations/20260826000004_replace_byte_limit_with_audio_limit.sql', 'utf8');
  const activeSubscription = await readFile('supabase/migrations/20260826000005_allow_active_subscriptions.sql', 'utf8');
  const failedFreeLecture = await readFile('supabase/migrations/20260826000006_restore_failed_free_lectures.sql', 'utf8');
  assert.match(worker, /claim_lecture/);
  assert.match(app, /submitting\.current/);
  assert.match(worker, /billing\/meter_events/);
  assert.match(billing, /mode: 'subscription'/);
  assert.match(billing, /returnUrl\.origin !== origin/);
  assert.match(app, /returnUrl: `\$\{window\.location\.origin\}\$\{window\.location\.pathname\}`/);
  assert.match(migration, /file_size_limit = 26214400/);
  assert.match(migration, /char_length\(synthesis_prompt\) <= 1500/);
  assert.match(materialLimit, /material_bytes > 5242880/);
  assert.match(activeSubscription, /subscription_status in \('active', 'trialing'\) then/);
  assert.match(failedFreeLecture, /status <> 'error'/);
  assert.doesNotMatch(worker, /materialObjects/);
});

test('billing handles cancellations and failed invoices, and the UI separates saved sessions', async () => {
  const webhook = await readFile('supabase/functions/stripe-webhook/index.ts', 'utf8');
  const app = await readFile('src.tsx', 'utf8');
  assert.match(webhook, /customer\.subscription\./);
  assert.match(webhook, /invoice\.payment_failed/);
  assert.match(webhook, /subscription_status: 'past_due'/);
  assert.match(app, /#saved-sessions/);
  assert.match(app, /<details className="profile">/);
  assert.match(app, /lectures remaining this month/);
});

test('browser recordings are compact and capped at a lecture length', async () => {
  const app = await readFile('src.tsx', 'utf8');
  assert.match(app, /MAX_AUDIO_SECONDS = 90 \* 60/);
  assert.match(app, /audioBitsPerSecond: 32000/);
  assert.match(app, /channelCount: 1/);
  assert.match(app, /at most 90 minutes of audio/);
});

test('course materials can be selected or dropped before processing', async () => {
  const app = await readFile('src.tsx', 'utf8');
  assert.match(app, /function queueMaterials/);
  assert.match(app, /function removeMaterial/);
  assert.match(app, /onDrop=\{dropFiles\}/);
  assert.match(app, /Course materials can total at most 5 MB/);
  assert.match(app, /status === "Study notes are ready\."/);
});
