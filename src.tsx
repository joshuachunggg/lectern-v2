import { createClient } from '@supabase/supabase-js';
import { FormEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const url = import.meta.env.VITE_SUPABASE_URL, key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error('Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to .env.local.');
const supabase = createClient(url, key);
type Lecture = { id: string; title: string; status: string; status_message: string; notes: string | null; created_at: string };

function App() {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [user, setUser] = useState(false), [lectures, setLectures] = useState<Lecture[]>([]), [title, setTitle] = useState('Untitled lecture'), [files, setFiles] = useState<File[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const load = async () => { const { data } = await supabase.from('lectures').select('*').order('created_at', { ascending: false }); setLectures(data ?? []); };
  useEffect(() => { supabase.auth.getUser().then(({ data }) => { setUser(Boolean(data.user)); if (data.user) load(); }); const { data } = supabase.auth.onAuthStateChange((_event, session) => { setUser(Boolean(session)); if (session) load(); }); const poll = window.setInterval(() => { if (user) load(); }, 2000); return () => { data.subscription.unsubscribe(); clearInterval(poll); }; }, [user]);
  async function authenticate(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setMessage(''); const { error } = await supabase.auth.signInWithPassword({ email, password }); if (error) setMessage(error.message); }
  async function signUp() { const { error } = await supabase.auth.signUp({ email, password }); setMessage(error?.message ?? 'Check your email to confirm your account.'); }
  async function createLecture(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!files.length) return setMessage('Add at least one audio or text file.'); setBusy(true); setMessage('Uploading…'); try { const { data: lecture, error } = await supabase.from('lectures').insert({ title }).select().single(); if (error || !lecture) throw error ?? new Error('Could not create lecture.'); for (const file of files) { const path = `${lecture.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`; const { error: uploadError } = await supabase.storage.from('lecture-files').upload(path, file, { contentType: file.type || 'application/octet-stream' }); if (uploadError) throw uploadError; const { error: sourceError } = await supabase.from('lecture_sources').insert({ lecture_id: lecture.id, storage_path: path, filename: file.name, content_type: file.type || 'application/octet-stream', source_type: file.type.startsWith('audio/') ? 'audio' : 'material' }); if (sourceError) throw sourceError; }
      setMessage('Starting transcription…'); const { error: processError } = await supabase.functions.invoke('process-lecture', { body: { lecture_id: lecture.id } }); if (processError) throw processError; setFiles([]); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not process lecture.'); } finally { setBusy(false); }
  }
  if (!user) return <main><h1>lectern</h1><p>Cloud lecture notes.</p><form onSubmit={authenticate}><input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required /><input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required /><button>Sign in</button><button type="button" onClick={signUp}>Create account</button></form><p>{message}</p></main>;
  return <main><header><h1>lectern</h1><button onClick={() => supabase.auth.signOut()}>Sign out</button></header><form className="new" onSubmit={createLecture}><label>Lecture title<input value={title} onChange={e => setTitle(e.target.value)} /></label><label>Audio or text material<input type="file" accept="audio/*,.txt" multiple onChange={e => setFiles(Array.from(e.target.files ?? []))} /></label><button disabled={busy}>{busy ? 'Working…' : 'Create study notes'}</button></form><p aria-live="polite">{message}</p><section>{lectures.map(lecture => <article key={lecture.id}><h2>{lecture.title}</h2><p>{lecture.status_message}</p>{lecture.notes && <pre>{lecture.notes}</pre>}</article>)}</section></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
