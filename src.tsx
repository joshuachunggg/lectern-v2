import { createClient } from "@supabase/supabase-js";
import { ChangeEvent, DragEvent, FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./style.css";

const url = import.meta.env.VITE_SUPABASE_URL,
  key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key)
  throw new Error(
    "Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to .env.local.",
  );
const supabase = createClient(url, key);
const MAX_PROMPT_CHARS = 1500;
const MAX_COURSE_MATERIAL_BYTES = 5 * 1024 * 1024;
const materialSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const MAX_AUDIO_SECONDS = 90 * 60;
const MAX_TRANSCRIPTION_FILE_BYTES = 24 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "webm", "ogg", "aac", "flac"]);
const audioDuration = (file: File) => new Promise<number>((resolve, reject) => {
  const audio = document.createElement("audio"), url = URL.createObjectURL(file);
  audio.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(audio.duration); };
  audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not read ${file.name}.`)); };
  audio.src = url;
});
const isAudio = (file: File) => AUDIO_EXTENSIONS.has(file.name.toLowerCase().split(".").pop() ?? "");
const wavHeader = (samples: number) => {
  const bytes = new ArrayBuffer(44), view = new DataView(bytes);
  view.setUint32(0, 0x52494646, false); view.setUint32(4, 36 + samples * 2, true); view.setUint32(8, 0x57415645, false); view.setUint32(12, 0x666d7420, false); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(36, 0x64617461, false); view.setUint32(40, samples * 2, true);
  return bytes;
};
const wav = (samples: Float32Array, start: number, end: number) => {
  const bytes = new ArrayBuffer(44 + (end - start) * 2), view = new DataView(bytes); new Uint8Array(bytes).set(new Uint8Array(wavHeader(end - start)));
  for (let index = start; index < end; index += 1) view.setInt16(44 + (index - start) * 2, Math.max(-1, Math.min(1, samples[index])) * 0x7fff, true);
  return new Blob([bytes], { type: "audio/wav" });
};
const validWav = async (blob: Blob) => new TextDecoder().decode(await blob.slice(0, 4).arrayBuffer()) === "RIFF";
const repairWav = async (blob: Blob) => new Blob([wavHeader(Math.floor((blob.size - 44) / 2)), await blob.slice(44).arrayBuffer()], { type: "audio/wav" });
const chunkAudio = async (file: File) => {
  if (file.size <= MAX_TRANSCRIPTION_FILE_BYTES) return [file];
  // ponytail: browser decode uses memory; add server-side transcoding only if 90-minute uploads exceed browser capacity.
  const context = new AudioContext({ sampleRate: 16000 });
  try {
    const audio = await context.decodeAudioData(await file.arrayBuffer()), samples = audio.getChannelData(0), chunkSamples = Math.floor((MAX_TRANSCRIPTION_FILE_BYTES - 44) / 2), name = file.name.replace(/\.[^.]+$/, "");
    return Array.from({ length: Math.ceil(samples.length / chunkSamples) }, (_, index) => new File([wav(samples, index * chunkSamples, Math.min(samples.length, (index + 1) * chunkSamples))], `${name}-${String(index + 1).padStart(2, "0")}.wav`, { type: "audio/wav" }));
  } finally { await context.close(); }
};
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
type SlideMode = "text" | "original";
type Lecture = {
  id: string;
  title: string;
  slide_mode: SlideMode;
  status: string;
  status_message: string;
  notes: string | null;
  synthesis_prompt: string;
};
type SavedPrompt = { id: string; name: string; prompt: string };
type Billing = { active: boolean; included_used: number; overage_used: number; free_used: boolean };

function App() {
  const recorder = useRef<MediaRecorder | null>(null),
    timer = useRef<ReturnType<typeof setInterval> | null>(null),
    notesDialog = useRef<HTMLDialogElement | null>(null),
    contentDialog = useRef<HTMLDialogElement | null>(null),
    promptDialog = useRef<HTMLDialogElement | null>(null),
    submitting = useRef(false);
  const [user, setUser] = useState<string | null>(null),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [authError, setAuthError] = useState(""),
    [page, setPage] = useState(() => window.location.hash === "#saved-sessions" ? "saved" : window.location.hash === "#manage-plan" ? "plan" : "new"),
    [billing, setBilling] = useState<Billing | null>(null),
    [lectures, setLectures] = useState<Lecture[]>([]),
    [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]),
    [lecture, setLecture] = useState("Untitled lecture"),
    [slideMode, setSlideMode] = useState<SlideMode>("text"),
    [recording, setRecording] = useState(false),
    [seconds, setSeconds] = useState(0),
    [audio, setAudio] = useState<Blob | null>(null),
    [audioUrl, setAudioUrl] = useState(""),
    [audioFiles, setAudioFiles] = useState<File[]>([]),
    [files, setFiles] = useState<File[]>([]),
    [materials, setMaterials] = useState(""),
    [notePrompt, setNotePrompt] = useState(""),
    [promptName, setPromptName] = useState(""),
    [promptSession, setPromptSession] = useState<Lecture | null>(null),
    [contentSession, setContentSession] = useState<Lecture | null>(null),
    [editingTitle, setEditingTitle] = useState<string | null>(null),
    [titleDraft, setTitleDraft] = useState(""),
    [status, setStatus] = useState("Ready to record"),
    [processing, setProcessing] = useState(false),
    [notes, setNotes] = useState("");
  const loadLectures = async () => {
    const { data } = await supabase
      .from("lectures")
      .select("*")
      .order("created_at", { ascending: false });
    setLectures(data ?? []);
  };
  const loadSavedPrompts = async () => {
    const { data } = await supabase
      .from("saved_prompts")
      .select("id,name,prompt")
      .order("created_at", { ascending: false });
    setSavedPrompts(data ?? []);
  };
  const loadBilling = async () => {
    const { data } = await supabase.functions.invoke("billing", { body: { action: "status" } });
    if (data) setBilling(data as Billing);
  };

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const email = data.user?.email ?? null;
      setUser(email);
      if (email) {
        loadLectures();
        loadSavedPrompts();
        loadBilling();
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const email = session?.user.email ?? null;
      setUser(email);
      if (email) {
        loadLectures();
        loadSavedPrompts();
        loadBilling();
      }
    });
    return () => {
      data.subscription.unsubscribe();
      if (timer.current) clearInterval(timer.current);
    };
  }, []);
  useEffect(() => {
    const updatePage = () => setPage(window.location.hash === "#saved-sessions" ? "saved" : window.location.hash === "#manage-plan" ? "plan" : "new");
    window.addEventListener("hashchange", updatePage);
    return () => window.removeEventListener("hashchange", updatePage);
  }, []);
  useEffect(() => {
    if (notes) notesDialog.current?.showModal();
  }, [notes]);
  const redirectTo = `${window.location.origin}${import.meta.env.BASE_URL}`;
  async function authenticate(mode: "signin" | "signup") {
    setAuthError("");
    const result =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: redirectTo },
          });
    if (result.error) return setAuthError(result.error.message);
    if (mode === "signup" && !result.data.user?.identities?.length)
      return setAuthError("An account already exists for this email. Sign in instead.");
    if (mode === "signup")
      setAuthError("Check your email to confirm your account.");
  }
  async function openStripeBilling() {
    const action = billing?.active ? "portal" : "checkout";
    const { data, error } = await supabase.functions.invoke("billing", { body: { action, returnUrl: `${window.location.origin}${window.location.pathname}#manage-plan` } });
    if (error || !data?.url) return setStatus(error?.message ?? "Could not open billing.");
    window.location.assign(data.url);
  }
  async function upload(id: string, file: File) {
    const path = `${id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const { error: uploadError } = await supabase.storage
      .from("lecture-files")
      .upload(path, file, {
        contentType: file.type || "application/octet-stream",
      });
    if (uploadError) throw uploadError;
    const { error } = await supabase.from("lecture_sources").insert({
      lecture_id: id,
      storage_path: path,
      filename: file.name,
      content_type: file.type || "application/octet-stream",
      source_type: file.type.startsWith("audio/") || AUDIO_EXTENSIONS.has(file.name.toLowerCase().split(".").pop() ?? "") ? "audio" : "material",
    });
    if (error) throw error;
  }
  async function chunkStoredAudio(id: string) {
    const { data: sources, error } = await supabase.from("lecture_sources").select("id,storage_path,filename,content_type,source_type").eq("lecture_id", id);
    if (error) throw error;
    for (const source of sources ?? []) {
      if (source.source_type !== "audio") continue;
      const { data: blob, error: downloadError } = await supabase.storage.from("lecture-files").download(source.storage_path);
      if (downloadError || !blob) throw downloadError ?? new Error(`Could not download ${source.filename}.`);
      const repair = source.content_type === "audio/wav" && !await validWav(blob);
      if (blob.size <= MAX_TRANSCRIPTION_FILE_BYTES && !repair) continue;
      setStatus(`Splitting ${source.filename} for transcription…`);
      const chunks = repair ? [new File([await repairWav(blob)], source.filename, { type: "audio/wav" })] : await chunkAudio(new File([blob], source.filename, { type: source.content_type }));
      if ((sources?.length ?? 0) - 1 + chunks.length > 12) throw new Error("This lecture becomes more than 12 audio chunks. Split it into fewer recordings.");
      for (const chunk of chunks) await upload(id, chunk);
      const { error: deleteError } = await supabase.from("lecture_sources").delete().eq("id", source.id); if (deleteError) throw deleteError;
      await supabase.storage.from("lecture-files").remove([source.storage_path]);
    }
  }
  async function processLecture(
    id: string,
    message: string,
    synthesizeOnly = false,
  ) {
    setProcessing(true);
    setNotes("");
    setStatus(message);
    let poll: ReturnType<typeof window.setInterval> | undefined;
    try {
      await chunkStoredAudio(id);
      poll = window.setInterval(async () => {
        const { data } = await supabase
          .from("lectures")
          .select("status_message")
          .eq("id", id)
          .single();
        if (data) setStatus(data.status_message);
      }, 1500);
      const { error } = await supabase.functions.invoke("process-lecture", {
        body: { lecture_id: id, synthesize_only: synthesizeOnly },
      });
      if (error) {
        const body =
          error.context instanceof Response
            ? await error.context.json().catch(() => null)
            : null;
        throw new Error(body?.error ?? error.message);
      }
      await loadLectures();
      await loadBilling();
      const { data } = await supabase
        .from("lectures")
        .select("notes,status_message")
        .eq("id", id)
        .single();
      if (data?.notes) setNotes(data.notes);
      if (data?.status_message) setStatus(data.status_message);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Could not process lecture.",
      );
      throw error;
    } finally {
      if (poll) clearInterval(poll);
      setProcessing(false);
    }
  }
  async function toggleRecording() {
    if (recording) return recorder.current?.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } }),
        chunks: Blob[] = [],
        next = new MediaRecorder(stream, { audioBitsPerSecond: 32000 });
      next.ondataavailable = (event) =>
        event.data.size && chunks.push(event.data);
      next.onstop = () => {
        const saved = new Blob(chunks, { type: next.mimeType });
        setAudio(saved);
        setAudioUrl(URL.createObjectURL(saved));
        stream.getTracks().forEach((track) => track.stop());
        if (timer.current) clearInterval(timer.current);
        setRecording(false);
        setStatus("Recording saved locally in this tab");
      };
      recorder.current = next;
      next.start();
      setSeconds(0);
      timer.current = setInterval(() => setSeconds((value) => { if (value + 1 >= MAX_AUDIO_SECONDS) { next.stop(); return MAX_AUDIO_SECONDS; } return value + 1; }), 1000);
      setRecording(true);
      setStatus("Recording");
    } catch {
      setStatus("Microphone access is required to record.");
    }
  }
  function queueMaterials(added: File[]) {
    if (!added.length) return;
    setFiles((current) => {
      const next = [...current, ...added];
      if (next.reduce((total, file) => total + file.size, 0) > MAX_COURSE_MATERIAL_BYTES) {
        setStatus("Course materials can total at most 5 MB.");
        return current;
      }
      setStatus(`${added.length} course material${added.length === 1 ? "" : "s"} ready — uploaded when you make study notes.`);
      return next;
    });
  }
  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    queueMaterials(Array.from(event.target.files ?? []));
    event.target.value = "";
  }
  function dropFiles(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    queueMaterials(Array.from(event.dataTransfer.files));
  }
  function removeMaterial(index: number) {
    setFiles((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }
  function addAudio(event: ChangeEvent<HTMLInputElement>) {
    const added = Array.from(event.target.files ?? []);
    if (added.length) {
      setAudioFiles((current) => [...current, ...added]);
      setStatus(
        `${added.length} audio file${added.length === 1 ? "" : "s"} added`,
      );
    }
    event.target.value = "";
  }
  async function makeNotes() {
    const sources = [
      ...(audio
        ? [
            new File([audio], "recording.webm", {
              type: audio.type || "audio/webm",
            }),
          ]
        : []),
      ...audioFiles,
      ...files,
      ...(materials.trim()
        ? [new File([materials], "pasted-material.txt", { type: "text/plain" })]
        : []),
    ];
    if (!sources.length) return;
    if (files.reduce((total, file) => total + file.size, 0) > MAX_COURSE_MATERIAL_BYTES)
      return setStatus("Course materials can total at most 5 MB.");
    if ((await Promise.all(sources.filter(isAudio).map(audioDuration))).reduce((total, seconds) => total + seconds, 0) > MAX_AUDIO_SECONDS)
      return setStatus("A lecture can contain at most 90 minutes of audio.");
    if (notePrompt.length > MAX_PROMPT_CHARS)
      return setStatus("Custom note preferences are limited to 1,500 characters.");
    if (submitting.current) return;
    submitting.current = true;
    setProcessing(true);
    setNotes("");
    setStatus("Preparing audio…");
    try {
      const uploadSources = (await Promise.all(sources.map(file => isAudio(file) ? chunkAudio(file) : [file]))).flat();
      if (uploadSources.length > 12) throw new Error("This lecture becomes more than 12 audio chunks. Split it into fewer recordings.");
      setStatus("Creating lecture session…");
      const { data: created, error } = await supabase
        .from("lectures")
        .insert({
          title: lecture,
          slide_mode: slideMode,
          synthesis_prompt: notePrompt.trim(),
        })
        .select()
        .single();
      if (error || !created)
        throw error ?? new Error("Could not create the lecture session.");
      for (const [index, file] of uploadSources.entries()) {
        setStatus(
          `Uploading source ${index + 1} of ${uploadSources.length}: ${file.name}`,
        );
        await upload(created.id, file);
      }
      await processLecture(created.id, "Starting transcription…");
      setAudio(null);
      setAudioFiles([]);
      setFiles([]);
      setMaterials("");
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Could not create the lecture session.",
      );
      setProcessing(false);
    } finally { submitting.current = false; }
  }
  async function addToLecture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!contentSession) return;
    const form = event.currentTarget,
      data = new FormData(form),
      added = [
        ...Array.from(data.getAll("audio")).filter((file): file is File => file instanceof File && file.size > 0),
        ...Array.from(data.getAll("materials")).filter((file): file is File => file instanceof File && file.size > 0),
      ],
      transcript = String(data.get("transcript") ?? "").trim();
    if (transcript)
      added.push(
        new File([transcript], "pasted-transcript.txt", { type: "text/plain" }),
      );
    if (!added.length) return;
    try {
      if ((await Promise.all(added.filter(isAudio).map(audioDuration))).reduce((total, seconds) => total + seconds, 0) > MAX_AUDIO_SECONDS)
        return setStatus("Added audio can contain at most 90 minutes.");
      setProcessing(true);
      setStatus("Preparing audio…");
      const uploadSources = (await Promise.all(added.map(file => isAudio(file) ? chunkAudio(file) : [file]))).flat();
      if (uploadSources.length > 12) throw new Error("This lecture becomes more than 12 audio chunks. Split it into fewer recordings.");
      setStatus(`Uploading sources for ${contentSession.title}…`);
      for (const file of uploadSources) await upload(contentSession.id, file);
      contentDialog.current?.close();
      form.reset();
      await processLecture(contentSession.id, "Sources added — rebuilding notes…");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Could not upload the files.",
      );
      setProcessing(false);
    }
  }
  function openPrompt(session: Lecture | null) {
    setPromptSession(session);
    setNotePrompt(session?.synthesis_prompt ?? notePrompt);
    setPromptName("");
    promptDialog.current?.showModal();
  }
  async function savePrompt() {
    const name = promptName.trim(), prompt = notePrompt.trim();
    if (!name || !prompt) return;
    if (prompt.length > MAX_PROMPT_CHARS)
      return setStatus("Custom note preferences are limited to 1,500 characters.");
    const { error } = await supabase.from("saved_prompts").insert({ name, prompt });
    if (error) return setStatus(error.message);
    setPromptName("");
    await loadSavedPrompts();
  }
  async function redoNotes() {
    if (!promptSession) return;
    const session = promptSession, prompt = notePrompt.trim();
    const { error } = await supabase
      .from("lectures")
      .update({ synthesis_prompt: prompt })
      .eq("id", session.id);
    if (error) return setStatus(error.message);
    try {
      promptDialog.current?.close();
      await processLecture(session.id, "Rebuilding study notes…", true);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Could not rebuild the notes.",
      );
    }
  }
  async function saveTitle(session: Lecture) {
    const title = titleDraft.trim();
    if (!title || title === session.title) return;
    const { error } = await supabase
      .from("lectures")
      .update({ title })
      .eq("id", session.id);
    if (error) return setStatus(error.message);
    await loadLectures();
    setEditingTitle(null);
  }
  async function deleteLecture(session: Lecture) {
    if (!window.confirm(`Delete “${session.title}” and its source files?`))
      return;
    const { data: sources, error: sourcesError } = await supabase
      .from("lecture_sources")
      .select("storage_path")
      .eq("lecture_id", session.id);
    if (sourcesError) return setStatus(sourcesError.message);
    const paths = sources.map((source) => source.storage_path);
    if (paths.length) {
      const { error } = await supabase.storage.from("lecture-files").remove(paths);
      if (error) return setStatus(error.message);
    }
    const { error } = await supabase.from("lectures").delete().eq("id", session.id);
    if (error) return setStatus(error.message);
    setNotes("");
    setStatus(`Deleted ${session.title}.`);
    await loadLectures();
  }
  const canProcess = Boolean(
    audio || audioFiles.length || files.length || materials.trim(),
  );
  const courseMaterialBytes = files.reduce((total, file) => total + file.size, 0);
  const stage =
    status.includes("Uploading") ||
    status.includes("Creating") ||
    status.includes("Starting")
      ? 1
      : status.includes("Transcribing")
        ? 2
          : status.includes("Writing")
          ? 4
          : status === "Study notes are ready."
            ? 5
            : 0;

  if (!user)
    return (
      <main className="auth">
        <a className="brand" href="/">
          lectern
        </a>
        <section>
          <p className="eyebrow">Your lecture workspace</p>
          <h1>Sign in</h1>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) =>
              event.key === "Enter" && authenticate("signin")
            }
          />
          {authError && <p className="auth-error">{authError}</p>}
          <button onClick={() => authenticate("signin")}>Sign in</button>
          <button className="secondary" onClick={() => authenticate("signup")}>
            Create account
          </button>
        </section>
      </main>
    );
  return (
    <main>
      <header>
        <a className="brand" href="#new-session">
          lectern
        </a>
        <nav aria-label="Workspace">
          <a className={page === "new" ? "active" : ""} href="#new-session">New session</a>
          <a className={page === "saved" ? "active" : ""} href="#saved-sessions">Saved sessions</a>
        </nav>
        <details className="profile">
          <summary><span>{user}</span><small>{billing?.active ? "Paid plan" : "Free plan"}</small></summary>
          <div>
            <p>{billing?.active ? billing.overage_used ? `${billing.overage_used} overage lectures used` : `${Math.max(0, 24 - billing.included_used)} included lectures remaining this month` : `${billing?.free_used ? 0 : 1} free lecture remaining`}</p>
            <a className="sign-out" href="#manage-plan">Manage plan</a>
            <button className="sign-out" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        </details>
      </header>
      {page === "plan" && <section className="plan" id="manage-plan">
        <p className="eyebrow">Manage plan</p>
        <h1>{billing?.active ? "Lectern plan" : "Free plan"}</h1>
        {billing?.active ? <>
          <p>Includes 24 lectures each month, then $0.50 per lecture.</p>
          <dl><div><dt>Included lectures remaining</dt><dd>{Math.max(0, 24 - billing.included_used)}</dd></div><div><dt>Overage lectures used</dt><dd>{billing.overage_used}</dd></div><div><dt>Overage cost this month</dt><dd>${(billing.overage_used * 0.5).toFixed(2)}</dd></div></dl>
          <button onClick={openStripeBilling}>Manage billing in Stripe</button>
        </> : <>
          <p>Your first lecture is free. The Lectern plan is $10/month and includes 24 lectures, then $0.50 per lecture.</p>
          <button onClick={openStripeBilling}>Subscribe in Stripe</button>
        </>}
      </section>}
      {page === "new" && <>
      <section className="intro" id="new-session">
        <p className="eyebrow">New session</p>
        <input
          aria-label="Lecture title"
          value={lecture}
          onChange={(event) => setLecture(event.target.value)}
        />
        <p>
          Capture the lecture now. Turn it into notes when you are done
          listening.
        </p>
      </section>
      <section className="workspace" aria-label="Lecture workspace">
        <article className="recorder card">
          <div className="card-heading">
            <span>01</span>
            <p>Lecture audio</p>
          </div>
          <div className="card-body">
            <div className={`record-light ${recording ? "live" : ""}`} />
            <p className="time">{clock(seconds)}</p>
            <p className="status" aria-live="polite">
              {status}
            </p>
            <button
              className={recording ? "stop" : "record"}
              onClick={toggleRecording}
            >
              <i />
              {recording ? "Stop recording" : "Start recording"}
            </button>
            <label className="audio-upload">
              <input
                type="file"
                accept="audio/*,.m4a,.mp3,.wav,.webm"
                multiple
                onChange={addAudio}
              />
              Choose audio files
            </label>
            {audioFiles.length > 0 && (
              <small>
                {audioFiles.length} file{audioFiles.length === 1 ? "" : "s"} ready
                — uploaded in order as lecture-01, lecture-02, …
              </small>
            )}
            {audioUrl && (
              <audio controls src={audioUrl}>
                Your browser cannot play this recording.
              </audio>
            )}
          </div>
        </article>
        <article className="materials card">
          <div className="card-heading">
            <span>02</span>
            <p>Course materials</p>
          </div>
          <div className="card-body">
            <label className="dropzone" onDragOver={(event) => event.preventDefault()} onDrop={dropFiles}>
              <input
                type="file"
                accept=".pdf,.pptx,.txt"
                multiple
                onChange={addFiles}
              />
              <strong>Drop or choose slides</strong>
              <small>PDF, PowerPoint (.pptx), or plain text</small>
            </label>
            <label className="materials-label">
              <input
                type="checkbox"
                checked={slideMode === "original"}
                onChange={(event) =>
                  setSlideMode(event.target.checked ? "original" : "text")
                }
              />{" "}
              Let AI inspect original slides (visual)
            </label>
            {files.length > 0 && (
              <div className="queued-materials">
                <div><small>{materialSize(courseMaterialBytes)} of 5 MB queued</small><button type="button" onClick={() => setFiles([])}>Clear</button></div>
                <ul>
                  {files.map((file, index) => (
                    <li key={`${file.name}-${index}`}><span>{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeMaterial(index)}>Remove</button></li>
                  ))}
                </ul>
              </div>
            )}
            <label className="materials-label" htmlFor="materials">
              Or paste material
            </label>
            <textarea
              id="materials"
              value={materials}
              maxLength={100000}
              onChange={(event) => setMaterials(event.target.value)}
              placeholder="Paste the syllabus, an outline, or lecture context…"
            />
          </div>
        </article>
        <article className="synthesis card">
          <div className="card-heading">
            <span>03</span>
            <p>After the lecture</p>
          </div>
          <h2>Make study notes</h2>
          <p>
            Transcribe your lecture, then combine it with slides into structured
            notes.
          </p>
          <button className="secondary-action" onClick={() => openPrompt(null)}>
            {notePrompt ? "Edit custom note prompt" : "Add custom note prompt"}
          </button>
          <div className="progress" aria-live="polite">
            <strong>{status}</strong>
            <ol>
              {[
                "Upload source files",
                "Transcribe lecture",
                "Read course material",
                "Synthesize notes",
                "Study notes ready",
              ].map((label, index) => (
                <li
                  className={
                    stage > index + 1
                      ? "complete"
                      : stage === index + 1
                        ? "active"
                        : ""
                  }
                  key={label}
                >
                  {label}
                </li>
              ))}
            </ol>
          </div>
          <button disabled={!canProcess || processing} onClick={makeNotes}>
            {processing ? "Working…" : "Make study notes"}
          </button>
          <small>
            {canProcess
              ? "Your source material is ready."
              : "Record audio or add materials to continue."}
          </small>
        </article>
      </section>
      </>}
      {page === "saved" && (
        <section className="history" id="saved-sessions">
          <p className="eyebrow">Saved sessions</p>
          {lectures.length ? <div className="saved-session-list">
            {lectures.map((session) => (
              <article className="saved-session" key={session.id}>
                <button
                  className="delete-session"
                  aria-label={`Delete ${session.title}`}
                  title="Delete session"
                  onClick={() => deleteLecture(session)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 7h16M10 11v6m4-6v6M9 7l1-2h4l1 2m-9 0 1 13h10l1-13" />
                  </svg>
                </button>
                <div className="session-title">
                  {editingTitle === session.id ? (
                    <input
                      aria-label="Lecture title"
                      autoFocus
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onBlur={() => saveTitle(session)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") saveTitle(session);
                        if (event.key === "Escape") setEditingTitle(null);
                      }}
                    />
                  ) : (
                    <strong>{session.title}</strong>
                  )}
                  <button
                    className="edit-session"
                    aria-label={`Rename ${session.title}`}
                    title="Rename session"
                    onClick={() => {
                      setTitleDraft(session.title);
                      setEditingTitle(session.id);
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m4 16 9.5-9.5 3 3L7 19H4v-3Zm11-10.5 1.5-1.5 3 3L18 8.5l-3-3Z" />
                    </svg>
                  </button>
                </div>
                <small>
                  {session.status === "done"
                    ? "Notes ready"
                    : session.status_message}
                </small>
                <div>
                  {session.notes && (
                    <button onClick={() => setNotes(session.notes ?? "")}>
                      Open notes
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setContentSession(session);
                      contentDialog.current?.showModal();
                    }}
                  >
                    Add additional content
                  </button>
                  {session.status === "error" ? (
                    <button disabled={processing} onClick={() => processLecture(session.id, "Retrying processing…").catch(() => {})}>Retry processing</button>
                  ) : (
                    <button onClick={() => openPrompt(session)}>Redo notes</button>
                  )}
                </div>
              </article>
            ))}
          </div>
          : <p className="empty-sessions">No saved sessions yet.</p>}
        </section>
      )}
      <dialog className="modal" ref={contentDialog}>
        <form onSubmit={addToLecture}>
          <div className="modal-heading">
            <h2>Add additional content</h2>
            <button type="button" onClick={() => contentDialog.current?.close()}>
              Close
            </button>
          </div>
          <label>
            Audio files
            <input name="audio" type="file" accept="audio/*,.m4a,.mp3,.wav,.webm" multiple />
          </label>
          <label>
            Slides or materials
            <input name="materials" type="file" accept=".pdf,.ppt,.pptx,.txt" multiple />
          </label>
          <label>
            Or paste a transcript
            <textarea name="transcript" maxLength={100000} placeholder="Paste an additional lecture transcript…" />
          </label>
          <button disabled={processing}>Add content and rebuild notes</button>
        </form>
      </dialog>
      <dialog className="modal" ref={promptDialog}>
        <div className="modal-heading">
          <h2>Custom note prompt</h2>
          <button type="button" onClick={() => promptDialog.current?.close()}>
            Close
          </button>
        </div>
        <label htmlFor="note-prompt">Optional instructions for the AI</label>
        <textarea
          id="note-prompt"
          value={notePrompt}
          maxLength={MAX_PROMPT_CHARS}
          onChange={(event) => setNotePrompt(event.target.value)}
          placeholder="For example: prioritize exam-ready definitions, use a Cornell-note layout, and include worked examples."
        />
        {savedPrompts.length > 0 && (
          <div className="saved-prompts">
            <small>Saved prompts</small>
            {savedPrompts.map((prompt) => (
              <button key={prompt.id} type="button" onClick={() => setNotePrompt(prompt.prompt)}>
                {prompt.name}
              </button>
            ))}
          </div>
        )}
        <div className="save-prompt">
          <input
            value={promptName}
            onChange={(event) => setPromptName(event.target.value)}
            placeholder="Name this prompt"
            maxLength={100}
          />
          <button type="button" onClick={savePrompt} disabled={!promptName.trim() || !notePrompt.trim()}>
            Save prompt
          </button>
        </div>
        {promptSession ? (
          <button disabled={processing} onClick={redoNotes}>
            Redo AI synthesis
          </button>
        ) : (
          <button onClick={() => promptDialog.current?.close()}>Use this prompt</button>
        )}
      </dialog>
      {notes && (
        <dialog
          className="notes"
          ref={notesDialog}
          onCancel={(event) => {
            event.preventDefault();
            setNotes("");
          }}
        >
          <div className="notes-heading">
            <p className="eyebrow">Study notes</p>
            <div>
              <button
                onClick={() =>
                  navigator.clipboard
                    .writeText(notes.replace(/^( +)([-*+]|\d+[.)]) /gm, (_, indent, marker) => `${" ".repeat(Math.ceil(indent.length / 4) * 4)}${marker} `).replace(/[ \t]+$/gm, ""))
                    .then(() => setStatus("Notes copied to clipboard."))
                }
              >
                Copy all
              </button>
              <button onClick={() => setNotes("")}>Close</button>
            </div>
          </div>
          <article className="notes-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown>
          </article>
        </dialog>
      )}
      <footer>
        Audio and materials are saved privately while they are processed.
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
