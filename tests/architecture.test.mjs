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
  assert.match(worker, /createSignedUrl\(source\.storage_path, 3600\)/);
  assert.match(worker, /form\.append\('url', audioUrl\)/);
  assert.match(worker, /not a table of contents; never put links in the outline or headings/);
  assert.match(worker, /indent nested items with four spaces/);
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
  assert.match(app, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(app, /Math\.ceil\(indent\.length \/ 4\) \* 4/);
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

test('duplicate signups prompt the person to sign in', async () => {
  const app = await readFile('src.tsx', 'utf8');
  assert.match(app, /mode === "signup" && !result\.data\.user\?\.identities\?\.length/);
  assert.match(app, /An account already exists for this email\. Sign in instead\./);
});

test('edge function accepts browser CORS preflights', async () => {
  const worker = await readFile('supabase/functions/process-lecture/index.ts', 'utf8');
  assert.match(worker, /Access-Control-Allow-Origin/);
  assert.match(worker, /request\.method === 'OPTIONS'/);
});

test('slide files use an Edge-compatible base64 encoder', async () => {
  const worker = await readFile('supabase/functions/process-lecture/index.ts', 'utf8');
  assert.match(worker, /const base64 = \(bytes: Uint8Array\)/);
  assert.match(worker, /file_data: `data:\$\{source\.content_type\};base64,\$\{base64\(new Uint8Array\(await file\.arrayBuffer\(\)\)\)\}`/);
  assert.doesNotMatch(worker, /\.toBase64\(\)/);
});

test('processing resumes from completed source transcriptions', async () => {
  const worker = await readFile('supabase/functions/process-lecture/index.ts', 'utf8');
  const migration = await readFile('supabase/migrations/20260827000001_persist_source_transcripts.sql', 'utf8');
  const app = await readFile('src.tsx', 'utf8');
  assert.match(migration, /add column transcript text/);
  assert.match(worker, /source\.source_type === 'audio' && source\.transcript/);
  assert.match(worker, /from\('lecture_sources'\)\.update\(\{ transcript: result\.text \}\)/);
  assert.match(app, /Retry processing/);
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
  const firstFreeLecture = await readFile('supabase/migrations/20260826000007_claim_first_free_lecture.sql', 'utf8');
  const retryFailedFreeLecture = await readFile('supabase/migrations/20260826000017_retry_failed_free_lectures.sql', 'utf8');
  const countedFreeLecture = await readFile('supabase/migrations/20260826000018_count_failed_free_lectures.sql', 'utf8');
  const parameterizedFreeLecture = await readFile('supabase/migrations/20260826000019_parameterized_free_lecture_count.sql', 'utf8');
  const claimReturn = await readFile('supabase/migrations/20260827000000_return_after_claim.sql', 'utf8');
  const overages = await readFile('supabase/migrations/20260827000002_track_monthly_overages.sql', 'utf8');
  assert.match(worker, /claim_lecture_for_owner_v2/);
  assert.match(app, /submitting\.current/);
  assert.match(worker, /billing\/meter_events/);
  assert.match(billing, /mode: 'subscription'/);
  assert.match(billing, /overage_used/);
  assert.match(billing, /stripeSubscription\(account\.stripe_subscription_id\)/);
  assert.match(billing, /returnUrl\.origin !== origin/);
  assert.match(app, /returnUrl: `\$\{window\.location\.origin\}\$\{window\.location\.pathname\}#manage-plan`/);
  assert.match(migration, /file_size_limit = 26214400/);
  assert.match(migration, /char_length\(synthesis_prompt\) <= 1500/);
  assert.match(materialLimit, /material_bytes > 5242880/);
  assert.match(activeSubscription, /subscription_status in \('active', 'trialing'\) then/);
  assert.match(failedFreeLecture, /status <> 'error'/);
  assert.match(firstFreeLecture, /coalesce\(account\.free_used, false\) = false/);
  assert.match(retryFailedFreeLecture, /billing_kind = 'free' and status <> 'error'/);
  assert.match(countedFreeLecture, /count\(\*\).*billing_kind = 'free' and status <> 'error'/);
  assert.match(parameterizedFreeLecture, /execute 'select count\(\*\).*owner_id = \$1/);
  assert.match(claimReturn, /return query select 'free'::text, null::text; return;/);
  assert.match(overages, /add column overage_used integer/);
  assert.match(overages, /set overage_used = overage_used \+ 1/);
  assert.match(overages, /ends_at > now\(\)/);
  assert.doesNotMatch(worker, /materialObjects/);
});

test('billing handles cancellations and failed invoices, and the UI separates saved sessions', async () => {
  const webhook = await readFile('supabase/functions/stripe-webhook/index.ts', 'utf8');
  const app = await readFile('src.tsx', 'utf8');
  assert.match(webhook, /customer\.subscription\./);
  assert.match(webhook, /invoice\.payment_failed/);
  assert.match(webhook, /subscription_status: 'past_due'/);
  assert.match(webhook, /api\.stripe\.com\/v1\/subscriptions/);
  assert.match(webhook, /items\?\.data\?\.\[0\]\?\.current_period_end/);
  assert.match(app, /#saved-sessions/);
  assert.match(app, /<details className="profile">/);
  assert.match(app, /included lectures remaining this month/);
  assert.match(app, /overage lectures used/);
  assert.match(app, /Manage billing in Stripe/);
  assert.match(webhook, /overage_used: 0/);
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
  const style = await readFile('style.css', 'utf8');
  assert.match(app, /function queueMaterials/);
  assert.match(app, /function removeMaterial/);
  assert.match(app, /onDrop=\{dropFiles\}/);
  assert.match(app, /Course materials can total at most 5 MB/);
  assert.match(app, /status === "Study notes are ready\."/);
  assert.match(style, /\.queued-materials ul \{\n  max-height: 78px;/);
  assert.doesNotMatch(style, /^ul \{/m);
});
