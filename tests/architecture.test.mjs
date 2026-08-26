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
  assert.match(worker, /part\.type === 'output_text'/);
  assert.match(worker, /Note synthesis returned no text/);
  assert.doesNotMatch(worker, /sqlite|whisper|codex exec/i);
});

test('new lectures save optional note preferences', async () => {
  const app = await readFile('src.tsx', 'utf8');
  const migration = await readFile(
    'supabase/migrations/20260826000001_add_synthesis_prompt.sql',
    'utf8',
  );
  assert.match(app, /synthesis_prompt: notePrompt\.trim\(\)/);
  assert.match(app, /id="note-prompt"/);
  assert.match(migration, /synthesis_prompt/);
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
