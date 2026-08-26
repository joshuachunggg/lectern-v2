import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('cloud worker uses OpenAI APIs and no local database', async () => {
  const worker = await readFile('supabase/functions/process-lecture/index.ts', 'utf8');
  assert.match(worker, /\/audio\/transcriptions/);
  assert.match(worker, /\/responses/);
  assert.match(worker, /estimated_cost_usd/);
  assert.doesNotMatch(worker, /sqlite|whisper|codex exec/i);
});
