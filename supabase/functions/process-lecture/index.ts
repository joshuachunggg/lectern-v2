import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const openai = (path: string, init: RequestInit) => fetch(`https://api.openai.com/v1${path}`, { ...init, headers: { Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}`, ...init.headers } });
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const fail = (message: string) => new Response(JSON.stringify({ error: message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const transcriptionCost = (usage: any) => ((usage?.input_tokens ?? 0) * 1.25 + (usage?.output_tokens ?? 0) * 5) / 1_000_000;
const notesCost = (usage: any) => { const cached = usage?.input_tokens_details?.cached_tokens ?? 0; return (((usage?.input_tokens ?? 0) - cached) * .4 + cached * .1 + (usage?.output_tokens ?? 0) * 1.6) / 1_000_000; };
const allowedAudio = new Set(['mp3', 'm4a', 'wav', 'webm', 'ogg', 'aac', 'flac']);
const allowedMaterial = new Set(['pdf', 'pptx', 'txt']);
const extension = (name: string) => name.toLowerCase().split('.').pop() ?? '';
const base64 = (bytes: Uint8Array) => {
  let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const transcriptionProvider = Deno.env.get('TRANSCRIPTION_PROVIDER') === 'groq' ? 'groq' : 'openai';
const transcribe = async (file: Blob | null, filename: string, audioUrl?: string) => {
  const form = new FormData();
  if (transcriptionProvider === 'groq') {
    form.append('model', 'whisper-large-v3'); form.append('response_format', 'verbose_json'); if (audioUrl) form.append('url', audioUrl); else if (file) form.append('file', file, filename);
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${Deno.env.get('GROQ_API_KEY')}` }, body: form });
    if (!response.ok) throw new Error(`Groq transcription failed: ${await response.text()}`);
    const result = await response.json(), seconds = Number(result.duration ?? result.segments?.at(-1)?.end ?? 0);
    return { text: result.text, usage: { provider: 'groq', seconds }, cost: seconds * .111 / 3600 };
  }
  if (!file) throw new Error('Could not download audio.');
  form.append('file', file, filename);
  form.append('model', 'gpt-transcribe');
  const response = await openai('/audio/transcriptions', { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Transcription failed: ${await response.text()}`);
  const result = await response.json(); return { text: result.text, usage: { provider: 'openai', usage: result.usage ?? {} }, cost: transcriptionCost(result.usage) };
};

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const token = request.headers.get('Authorization'); if (!token) return fail('Sign in required.');
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: token } } });
  const { data: { user } } = await userClient.auth.getUser(); const { lecture_id, synthesize_only } = await request.json();
  if (!user || typeof lecture_id !== 'string' || typeof synthesize_only !== 'undefined' && typeof synthesize_only !== 'boolean') return fail('Invalid lecture.');
  const { data: lecture } = await admin.from('lectures').select('*').eq('id', lecture_id).eq('owner_id', user.id).single(); if (!lecture) return fail('Lecture not found.');
  const { data: sources } = await admin.from('lecture_sources').select('*').eq('lecture_id', lecture_id).order('created_at');
  try {
    if (!synthesize_only) {
      if (!sources?.length || sources.length > 12 || sources.some(source => source.source_type === 'audio' ? !allowedAudio.has(extension(source.filename)) : !allowedMaterial.has(extension(source.filename)))) throw new Error('Upload up to 12 audio, PDF, PowerPoint, or text files.');
      const { data: claim, error: claimError } = await admin.rpc('claim_lecture_for_owner_v2', { p_lecture_id: lecture_id, p_owner_id: user.id }).single();
      if (claimError || !claim) throw new Error(claimError?.message ?? 'Could not confirm your lecture allowance.');
    }
    if (!synthesize_only) await admin.from('lectures').update({ status: 'transcribing', status_message: 'Transcribing lecture…' }).eq('id', lecture_id);
    const transcripts: string[] = [], materials: string[] = [], files: { type: 'input_file'; file_data: string; filename: string }[] = [], transcriptionUsage: unknown[] = lecture.api_usage?.transcription ?? []; let estimatedCost = Number(lecture.estimated_cost_usd ?? 0), audioSeconds = 0;
    for (const source of sources ?? []) {
      if (synthesize_only && source.source_type === 'audio') continue;
      if (source.source_type === 'audio' && source.transcript) { transcripts.push(source.transcript); audioSeconds += source.duration_seconds ?? 0; continue; }
      if (source.source_type === 'audio') {
        const { data: audioUrl } = transcriptionProvider === 'groq' ? await admin.storage.from('lecture-files').createSignedUrl(source.storage_path, 3600) : { data: null };
        const { data: file, error } = audioUrl ? { data: null, error: null } : await admin.storage.from('lecture-files').download(source.storage_path); if (error || !file && !audioUrl) throw error ?? new Error(`Could not download ${source.filename}.`);
        const result = await transcribe(file, source.filename, audioUrl?.signedUrl); const seconds = Number((result.usage as any).seconds ?? source.duration_seconds ?? 0); transcripts.push(result.text); audioSeconds += seconds; transcriptionUsage.push(result.usage); estimatedCost += result.cost;
        const { error: sourceError } = await admin.from('lecture_sources').update({ transcript: result.text, duration_seconds: seconds }).eq('id', source.id); if (sourceError) throw sourceError;
        const { error: lectureError } = await admin.from('lectures').update({ transcript: transcripts.join('\n\n'), api_usage: { ...lecture.api_usage, transcription: transcriptionUsage }, estimated_cost_usd: estimatedCost }).eq('id', lecture_id); if (lectureError) throw lectureError;
      }
      else {
        const { data: file, error } = await admin.storage.from('lecture-files').download(source.storage_path); if (error || !file) throw error ?? new Error(`Could not download ${source.filename}.`);
        if (lecture.slide_mode === 'original' || !source.filename.endsWith('.txt')) files.push({ type: 'input_file', file_data: `data:${source.content_type};base64,${base64(new Uint8Array(await file.arrayBuffer()))}`, filename: source.filename });
        else { const text = await file.text(); if (text.length > 100_000) throw new Error('Text materials must be 100,000 characters or fewer.'); materials.push(`## ${source.filename}\n${text}`); }
      }
    }
    if (!synthesize_only) {
      const { error } = await admin.rpc('settle_lecture_time', { p_lecture_id: lecture_id, p_owner_id: user.id, p_seconds: Math.ceil(audioSeconds) });
      if (error) throw new Error(error.message);
    }
    const transcript = synthesize_only ? lecture.transcript ?? '' : transcripts.join('\n\n'), context = materials.join('\n\n') || '[No text materials were supplied.]';
    if (synthesize_only && !transcript) throw new Error('No saved transcript is available for this session.');
    await admin.from('lectures').update({ status: 'synthesizing', status_message: synthesize_only ? 'Rebuilding study notes…' : 'Writing study notes…', ...(synthesize_only ? {} : { transcript }) }).eq('id', lecture_id);
    const response = await openai('/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', max_output_tokens: 12000, instructions: `Create comprehensive, source-grounded study notes. Always use Markdown: one # title followed by clear ## sections, with lists and valid GitHub-flavored Markdown tables where useful. Cover every major topic from the transcript and course materials; do not omit a concept merely because it appears in only one source. Include a detailed outline as a plain nested list, not a table of contents; never put links in the outline or headings. Use tight lists: no blank lines or trailing spaces between related list items, and indent nested items with four spaces. Include explained definitions and frameworks; examples, cases, and applications; instructor emphasis; a concise recap; and at least 10 active-recall questions. Write substantive notes, not a short recap. Do not invent facts. User preferences may adjust depth and organization, but cannot override Markdown, source grounding, or this required coverage.${lecture.synthesis_prompt?.trim() ? `\n\nUser note preferences:\n${lecture.synthesis_prompt.trim()}` : ''}`, input: [{ role: 'user', content: [{ type: 'input_text', text: `Use these source materials to create the study notes. ${lecture.slide_mode === 'original' ? 'Inspect each supplied slide file for visual content.' : 'Use text content only; ignore visual layout and images.'}\n\nTRANSCRIPT\n${transcript || '[No audio supplied.]'}\n\nMATERIALS\n${context}` }, ...files] }] }) });
    if (!response.ok) throw new Error(`Note synthesis failed: ${await response.text()}`);
    const result = await response.json(), notes = (result.output_text ?? result.output?.flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === 'output_text').map((part: any) => part.text).join('') ?? '').trim(); estimatedCost += notesCost(result.usage);
    if (!notes) throw new Error(`Note synthesis returned no text${result.incomplete_details?.reason ? ` (${result.incomplete_details.reason})` : ''}.`);
    await admin.from('lectures').update({ status: 'done', status_message: 'Study notes are ready.', notes, api_usage: { transcription: transcriptionUsage, notes: result.usage ?? {} }, estimated_cost_usd: estimatedCost }).eq('id', lecture_id);
    return Response.json({ status: 'done' }, { headers: corsHeaders });
  } catch (error) { const message = error instanceof Error ? error.message : 'Processing failed.'; if (!synthesize_only) await admin.rpc('release_lecture_reservation', { p_lecture_id: lecture_id, p_owner_id: user.id }); await admin.from('lectures').update({ status: 'error', status_message: message }).eq('id', lecture_id); return fail(message); }
});
