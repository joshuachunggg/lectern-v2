import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const openai = (path: string, init: RequestInit) => fetch(`https://api.openai.com/v1${path}`, { ...init, headers: { Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}`, ...init.headers } });
const fail = (message: string) => new Response(JSON.stringify({ error: message }), { status: 400, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async request => {
  const token = request.headers.get('Authorization');
  if (!token) return fail('Sign in required.');
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: token } } });
  const { data: { user } } = await userClient.auth.getUser();
  const { lecture_id } = await request.json();
  if (!user || typeof lecture_id !== 'string') return fail('Invalid lecture.');
  const { data: lecture } = await admin.from('lectures').select('*').eq('id', lecture_id).eq('owner_id', user.id).single();
  if (!lecture) return fail('Lecture not found.');
  const { data: sources } = await admin.from('lecture_sources').select('*').eq('lecture_id', lecture_id).order('created_at');
  try {
    await admin.from('lectures').update({ status: 'transcribing', status_message: 'Transcribing lecture…' }).eq('id', lecture_id);
    const transcripts: string[] = [], materials: string[] = [], files: { type: 'input_file'; file_data: string; filename: string }[] = [];
    for (const source of sources ?? []) {
      const { data: file, error } = await admin.storage.from('lecture-files').download(source.storage_path); if (error || !file) throw error ?? new Error(`Could not download ${source.filename}.`);
      if (source.source_type === 'audio') { const form = new FormData(); form.append('file', file, source.filename); form.append('model', 'gpt-4o-mini-transcribe'); const response = await openai('/audio/transcriptions', { method: 'POST', body: form }); if (!response.ok) throw new Error(`Transcription failed: ${await response.text()}`); transcripts.push((await response.json()).text); }
      else if (lecture.slide_mode === 'original' || !source.filename.endsWith('.txt')) files.push({ type: 'input_file', file_data: new Uint8Array(await file.arrayBuffer()).toBase64(), filename: source.filename });
      else materials.push(`## ${source.filename}\n${await file.text()}`);
    }
    const transcript = transcripts.join('\n\n'), context = materials.join('\n\n') || '[No text materials were supplied.]';
    await admin.from('lectures').update({ status: 'synthesizing', status_message: 'Writing study notes…', transcript }).eq('id', lecture_id);
    const response = await openai('/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', input: [{ role: 'user', content: [{ type: 'input_text', text: `Create accurate study notes from this lecture transcript and course material. ${lecture.slide_mode === 'original' ? 'Inspect each supplied slide file for visual content.' : 'Use text content only; ignore visual layout and images.'} Include an outline, definitions, examples, instructor emphasis, recap, and five active-recall questions. Do not invent facts.\n\nTRANSCRIPT\n${transcript || '[No audio supplied.]'}\n\nMATERIALS\n${context}` }, ...files] }] }) });
    if (!response.ok) throw new Error(`Note synthesis failed: ${await response.text()}`);
    const result = await response.json(); const notes = result.output_text ?? 'No notes were generated.';
    await admin.from('lectures').update({ status: 'done', status_message: 'Study notes are ready.', notes }).eq('id', lecture_id);
    return Response.json({ status: 'done' });
  } catch (error) { const message = error instanceof Error ? error.message : 'Processing failed.'; await admin.from('lectures').update({ status: 'error', status_message: message }).eq('id', lecture_id); return fail(message); }
});
