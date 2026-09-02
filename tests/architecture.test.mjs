import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('cloud worker uses OpenAI APIs and no local database', async () => {
  const worker = await readFile('supabase/functions/process-lecture/index.ts', 'utf8');
  assert.match(worker, /\/audio\/transcriptions/);
  assert.match(worker, /gpt-transcribe/);
  assert.match(worker, /\/responses/);
  assert.match(worker, /estimated_cost_usd/);
  assert.match(worker, /max_output_tokens: 4000 \+ detail \* 2400/);
  assert.match(worker, /## Big picture/);
  assert.match(worker, /## Retrieval practice/);
  assert.doesNotMatch(worker, /## Detailed outline/);
  assert.match(worker, /User note preferences/);
  assert.match(worker, /synthesize_only/);
  assert.match(worker, /synthesize_only && source\.source_type === 'audio'/);
  assert.match(worker, /part\.type === 'output_text'/);
  assert.match(worker, /Note synthesis returned no text/);
  assert.match(worker, /TRANSCRIPTION_PROVIDER/);
  assert.match(worker, /whisper-large-v3/);
  assert.match(worker, /createSignedUrl\(source\.storage_path, 3600\)/);
  assert.match(worker, /form\.append\('url', audioUrl\)/);
  assert.match(worker, /Do not create a separate outline, glossary, definitions section, or examples section/);
  assert.match(worker, /Use tight nested lists/);
  assert.match(worker, /Use this Markdown structure/);
  assert.match(worker, /const noteDepth/);
  assert.doesNotMatch(worker, /sqlite|codex exec/i);
});

test('new lectures save optional note preferences', async () => {
  const app = await readFile('src.tsx', 'utf8');
  const migration = await readFile(
    'supabase/migrations/20260826000001_add_synthesis_prompt.sql',
    'utf8',
  );
  assert.match(app, /synthesis_prompt: notePrompt\.trim\(\)/);
  assert.match(app, /note_detail: noteDetail/);
  assert.match(app, /aria-label="Note depth"/);
  assert.match(app, /id="note-prompt"/);
  assert.match(app, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(app, /Math\.ceil\(indent\.length \/ 4\) \* 4/);
  assert.match(app, /synthesize_only: synthesizeOnly/);
  assert.match(app, /Edit slides & redo notes/);
  assert.match(app, /removedContentSources/);
  assert.match(app, /pasted-material\.txt/);
  assert.match(app, /function openPrompt\(\)/);
  assert.match(app, /from\("saved_prompts"\)/);
  assert.doesNotMatch(app, /Paste transcript/);
  assert.doesNotMatch(app, /Estimated API cost/);
  assert.match(migration, /synthesis_prompt/);
  assert.match(await readFile('supabase/migrations/20260828000002_add_note_detail.sql', 'utf8'), /note_detail smallint not null default 3/);
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
  assert.match(worker, /from\('lecture_sources'\)\.update\(\{ transcript: result\.text, duration_seconds: seconds \}\)/);
  assert.match(app, /Retry processing/);
});

test('saved sessions can be deleted with their uploaded source files', async () => {
  const app = await readFile('src.tsx', 'utf8');
  const softDeleteMigration = await readFile('supabase/migrations/20260902000000_soft_delete_lectures.sql', 'utf8');
  assert.match(app, /async function deleteLecture/);
  assert.match(app, /async function saveRecording/);
  assert.match(app, /Recording saved — continue from Saved sessions\./);
  assert.match(app, /Make study notes/);
  assert.match(app, /deleted_at: new Date\(\)\.toISOString\(\)/);
  assert.match(app, /async function restoreLecture/);
  assert.match(app, /Recently deleted/);
  assert.match(softDeleteMigration, /add column deleted_at/);
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
  const prepaidCredits = await readFile('supabase/migrations/20260827000004_prepaid_overage_credits.sql', 'utf8');
  const timeBilling = await readFile('supabase/migrations/20260828000000_time_based_billing.sql', 'utf8');
  const hardenedBilling = await readFile('supabase/migrations/20260828000001_harden_subscription_billing.sql', 'utf8');
  assert.match(worker, /claim_lecture_for_owner_v2/);
  assert.match(app, /submitting\.current/);
  assert.match(billing, /mode: 'subscription'/);
  assert.match(billing, /credit_checkout/);
  assert.match(billing, /mode: 'payment'/);
  assert.match(billing, /credit_cents/);
  assert.match(billing, /Number\.isInteger\(creditCents\)/);
  assert.match(billing, /unit_amount\]': String\(creditCents\)/);
  assert.match(app, /min="0\.50" max="100" step="0\.01"/);
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
  assert.match(prepaidCredits, /add column credit_cents integer/);
  assert.match(prepaidCredits, /billing_credit_deposits/);
  assert.match(prepaidCredits, /credit_cents = credit_cents - 50/);
  assert.match(prepaidCredits, /credits < 50/);
  assert.match(prepaidCredits, /on conflict do nothing/);
  assert.match(timeBilling, /included_seconds integer/);
  assert.match(timeBilling, /settle_lecture_time/);
  assert.match(timeBilling, /108000/);
  assert.match(worker, /settle_lecture_time/);
  assert.match(worker, /release_lecture_reservation/);
  assert.match(hardenedBilling, /last_paid_period_end/);
  assert.match(hardenedBilling, /apply_paid_invoice/);
  assert.match(hardenedBilling, /release_lecture_reservation/);
  assert.match(hardenedBilling, /Service role required/);
  assert.doesNotMatch(worker, /materialObjects/);
});

test('billing handles subscriptions, prepaid deposits, and the UI separates saved sessions', async () => {
  const webhook = await readFile('supabase/functions/stripe-webhook/index.ts', 'utf8');
  const app = await readFile('src.tsx', 'utf8');
  assert.match(webhook, /customer\.subscription\./);
  assert.match(webhook, /invoice\.payment_failed/);
  assert.match(webhook, /subscription_status: 'past_due'/);
  assert.match(webhook, /api\.stripe\.com\/v1\/subscriptions/);
  assert.match(webhook, /items\?\.data\?\.\[0\]\?\.current_period_end/);
  assert.match(app, /#saved-sessions/);
  assert.match(app, /<details className="profile">/);
  assert.match(app, /Overage balance/);
  assert.match(app, /Add overage funds/);
  assert.match(app, /non-expiring balance/);
  assert.match(webhook, /overage_credit/);
  assert.match(webhook, /record_billing_credit_deposit/);
  assert.match(webhook, /apply_paid_invoice/);
  assert.match(app, /cancel_at/);
  assert.match(await readFile('supabase/migrations/20260828000001_harden_subscription_billing.sql', 'utf8'), /overage_seconds = 0/);
});

test('only the backend can set billing and processing fields', async () => {
  const migration = await readFile('supabase/migrations/20260901000000_harden_processing_access.sql', 'utf8');
  const followUpMigration = await readFile('supabase/migrations/20260901000001_require_audio_and_limit_redos.sql', 'utf8');
  const worker = await readFile('supabase/functions/process-lecture/index.ts', 'utf8');
  const billing = await readFile('supabase/functions/billing/index.ts', 'utf8');
  assert.match(migration, /revoke insert, update on public\.lectures from anon, authenticated/);
  assert.match(migration, /grant update \(title, slide_mode, synthesis_prompt, note_detail\) on public\.lectures to authenticated/);
  assert.match(migration, /revoke update on public\.lecture_sources from anon, authenticated/);
  assert.match(migration, /create or replace function public\.claim_note_run/);
  assert.match(followUpMigration, /note_runs < 2/);
  assert.match(migration, /Audio files must be audio sources/);
  assert.match(worker, /lecture\.billed_seconds !== null/);
  assert.match(worker, /Upload lecture audio before making study notes/);
  assert.match(worker, /result\.usage\?\.seconds/);
  assert.match(worker, /claim_note_run/);
  assert.match(billing, /Idempotency-Key/);
  assert.match(billing, /Billing setup is already in progress/);
  assert.match(billing, /new Date\(account\.period_end\) > new Date\(\)/);
});

test('recorded and uploaded audio is capped at a lecture length and prepared for transcription', async () => {
  const app = await readFile('src.tsx', 'utf8');
  assert.match(app, /MAX_AUDIO_SECONDS = 90 \* 60/);
  assert.match(app, /MAX_TRANSCRIPTION_FILE_BYTES = 24 \* 1024 \* 1024/);
  assert.match(app, /Number\.isFinite\(audio\.duration\)/);
  assert.match(app, /audio\.currentTime = 1e101/);
  assert.match(app, /new AudioContext\(\{ sampleRate: 16000 \}\)/);
  assert.match(app, /0x52494646/);
  assert.match(app, /repairWav/);
  assert.match(app, /chunkAudio\(file\)/);
  assert.match(app, /async function chunkStoredAudio/);
  assert.match(app, /new MediaRecorder\(stream, \{ audioBitsPerSecond: 32000 \}\)/);
  assert.match(app, /channelCount: 1/);
  assert.match(app, /Start recording/);
  assert.match(app, /current\.pause\(\)/);
  assert.match(app, /current\.resume\(\)/);
  assert.match(app, /Pause recording/);
  assert.match(app, /at most 90 minutes of audio/);
});

test('free users can compare plans and view finished transcripts', async () => {
  const app = await readFile('src.tsx', 'utf8');
  assert.match(app, /Upgrade to Lectern/);
  assert.match(app, /billing\?\.active && <a className="sign-out" href="#manage-plan">Manage plan<\/a>/);
  assert.match(app, /30 audio hours each month/);
  assert.match(app, /audio hours remaining/);
  assert.match(app, /Show transcript/);
  assert.match(app, /Copy transcript/);
  assert.match(app, /select\("notes,status_message,transcript"\)/);
});

test('paid users are sent to preload overage before a lecture can exceed included time', async () => {
  const app = await readFile('src.tsx', 'utf8');
  assert.match(app, /const requiredCreditCents = Math\.ceil/);
  assert.match(app, /audioSeconds > includedSeconds && currentBilling\.credit_cents < requiredCreditCents/);
  assert.match(app, /window\.location\.hash = "#manage-plan"/);
  assert.match(app, /This lecture may use overage/);
  assert.match(app, /30 audio hours each month—about 24 seventy-five-minute lectures/);
  assert.match(app, /Transcripts, notes, and custom instructions/);
});

test('lecture slides can be selected before processing', async () => {
  const app = await readFile('src.tsx', 'utf8');
  const style = await readFile('style.css', 'utf8');
  assert.match(app, /function queueMaterials/);
  assert.match(app, /Drop lecture slides here/);
  assert.match(app, /function removeMaterial/);
  assert.match(app, /PowerPoint files aren’t supported\. Export them as PDFs before uploading\./);
  assert.match(app, /accept="\.pdf,\.txt"/);
  assert.match(app, /function dropMaterials/);
  assert.match(app, /onDrop=\{dropMaterials\}/);
  assert.match(app, /is-dragging/);
  assert.match(app, /Lecture slides can total at most 5 MB/);
  assert.match(app, /status === "Study notes are ready\."/);
  assert.match(style, /\.file-queue ul \{ display: grid; gap: 7px; max-height: 136px;/);
  assert.doesNotMatch(style, /^ul \{/m);
});
