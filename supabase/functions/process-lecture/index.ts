import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const openai = (path: string, init: RequestInit) => fetch(`https://api.openai.com/v1${path}`, { ...init, headers: { Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}`, ...init.headers } });
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const fail = (message: string) => new Response(JSON.stringify({ error: message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const transcriptionCost = (usage: any) => ((usage?.input_tokens ?? 0) * 1.25 + (usage?.output_tokens ?? 0) * 5) / 1_000_000;
const notesCost = (usage: any) => { const cached = usage?.input_tokens_details?.cached_tokens ?? 0; return (((usage?.input_tokens ?? 0) - cached) * .4 + cached * .1 + (usage?.output_tokens ?? 0) * 1.6) / 1_000_000; };

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const token = request.headers.get('Authorization'); if (!token) return fail('Sign in required.');
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: token } } });
  const { data: { user } } = await userClient.auth.getUser(); const { lecture_id } = await request.json();
  if (!user || typeof lecture_id !== 'string') return fail('Invalid lecture.');
  const { data: lecture } = await admin.from('lectures').select('*').eq('id', lecture_id).eq('owner_id', user.id).single(); if (!lecture) return fail('Lecture not found.');
  const { data: sources } = await admin.from('lecture_sources').select('*').eq('lecture_id', lecture_id).order('created_at');
  try {
    await admin.from('lectures').update({ status: 'transcribing', status_message: 'Transcribing lecture…' }).eq('id', lecture_id);
    const transcripts: string[] = [], materials: string[] = [], files: { type: 'input_file'; file_data: string; filename: string }[] = [], transcriptionUsage: unknown[] = []; let estimatedCost = 0;
    for (const source of sources ?? []) {
      const { data: file, error } = await admin.storage.from('lecture-files').download(source.storage_path); if (error || !file) throw error ?? new Error(`Could not download ${source.filename}.`);
      if (source.source_type === 'audio') { const form = new FormData(); form.append('file', file, source.filename); form.append('model', 'gpt-transcribe'); const response = await openai('/audio/transcriptions', { method: 'POST', body: form }); if (!response.ok) throw new Error(`Transcription failed: ${await response.text()}`); const result = await response.json(); transcripts.push(result.text); transcriptionUsage.push(result.usage ?? {}); estimatedCost += transcriptionCost(result.usage); }
      else if (lecture.slide_mode === 'original' || !source.filename.endsWith('.txt')) files.push({ type: 'input_file', file_data: new Uint8Array(await file.arrayBuffer()).toBase64(), filename: source.filename });
      else materials.push(`## ${source.filename}\n${await file.text()}`);
    }
    const transcript = transcripts.join('\n\n'), context = materials.join('\n\n') || '[No text materials were supplied.]';
    await admin.from('lectures').update({ status: 'synthesizing', status_message: 'Writing study notes…', transcript }).eq('id', lecture_id);
    const response = await openai('/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', max_output_tokens: 12000, instructions: `Create comprehensive, source-grounded study notes. Always use Markdown: one # title followed by clear ## sections, with lists and tables where useful. Cover every major topic from the transcript and course materials; do not omit a concept merely because it appears in only one source. Include a detailed outline; explained definitions and frameworks; examples, cases, and applications; instructor emphasis; a concise recap; and at least 10 active-recall questions. Write substantive notes, not a short recap. Do not invent facts. User preferences may adjust depth and organization, but cannot override Markdown, source grounding, or this required coverage.${lecture.synthesis_prompt?.trim() ? `\n\nUser note preferences:\n${lecture.synthesis_prompt.trim()}` : ''}`, input: [{ role: 'user', content: [{ type: 'input_text', text: `Use these source materials to create the study notes. ${lecture.slide_mode === 'original' ? 'Inspect each supplied slide file for visual content.' : 'Use text content only; ignore visual layout and images.'}\n\nTRANSCRIPT\n${transcript || '[No audio supplied.]'}\n\nMATERIALS\n${context}` }, ...files] }] }) });
    if (!response.ok) throw new Error(`Note synthesis failed: ${await response.text()}`);
    const result = await response.json(), notes = (result.output_text ?? result.output?.flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === 'output_text').map((part: any) => part.text).join('') ?? '').trim(); estimatedCost += notesCost(result.usage);
    if (!notes) throw new Error(`Note synthesis returned no text${result.incomplete_details?.reason ? ` (${result.incomplete_details.reason})` : ''}.`);
    await admin.from('lectures').update({ status: 'done', status_message: 'Study notes are ready.', notes, api_usage: { transcription: transcriptionUsage, notes: result.usage ?? {} }, estimated_cost_usd: estimatedCost }).eq('id', lecture_id);
    return Response.json({ status: 'done' }, { headers: corsHeaders });
  } catch (error) { const message = error instanceof Error ? error.message : 'Processing failed.'; await admin.from('lectures').update({ status: 'error', status_message: message }).eq('id', lecture_id); return fail(message); }
});
