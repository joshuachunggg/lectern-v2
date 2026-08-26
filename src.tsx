import { createClient } from "@supabase/supabase-js";
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import "./style.css";

const url = import.meta.env.VITE_SUPABASE_URL,
  key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key)
  throw new Error(
    "Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to .env.local.",
  );
const supabase = createClient(url, key);
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
  estimated_cost_usd: number | null;
};

function App() {
  const recorder = useRef<MediaRecorder | null>(null),
    timer = useRef<ReturnType<typeof setInterval> | null>(null),
    notesDialog = useRef<HTMLDialogElement | null>(null);
  const [user, setUser] = useState<string | null>(null),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [authError, setAuthError] = useState(""),
    [lectures, setLectures] = useState<Lecture[]>([]),
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

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const email = data.user?.email ?? null;
      setUser(email);
      if (email) loadLectures();
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const email = session?.user.email ?? null;
      setUser(email);
      if (email) loadLectures();
    });
    return () => {
      data.subscription.unsubscribe();
      if (timer.current) clearInterval(timer.current);
    };
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
    if (mode === "signup")
      setAuthError("Check your email to confirm your account.");
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
      source_type: file.type.startsWith("audio/") ? "audio" : "material",
    });
    if (error) throw error;
  }
  async function processLecture(
    id: string,
    message: string,
    synthesizeOnly = false,
  ) {
    setProcessing(true);
    setNotes("");
    setStatus(message);
    const poll = window.setInterval(async () => {
      const { data } = await supabase
        .from("lectures")
        .select("status_message")
        .eq("id", id)
        .single();
      if (data) setStatus(data.status_message);
    }, 1500);
    try {
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
      clearInterval(poll);
      setProcessing(false);
    }
  }
  async function toggleRecording() {
    if (recording) return recorder.current?.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }),
        chunks: Blob[] = [],
        next = new MediaRecorder(stream);
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
      timer.current = setInterval(() => setSeconds((value) => value + 1), 1000);
      setRecording(true);
      setStatus("Recording");
    } catch {
      setStatus("Microphone access is required to record.");
    }
  }
  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    setFiles((current) => [
      ...current,
      ...Array.from(event.target.files ?? []),
    ]);
    event.target.value = "";
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
    setProcessing(true);
    setNotes("");
    setStatus("Creating lecture session…");
    try {
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
      for (const [index, file] of sources.entries()) {
        setStatus(
          `Uploading source ${index + 1} of ${sources.length}: ${file.name}`,
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
    }
  }
  async function addToLecture(
    session: Lecture,
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const added = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!added.length) return;
    try {
      setProcessing(true);
      setStatus(`Uploading sources for ${session.title}…`);
      for (const file of added) await upload(session.id, file);
      await processLecture(session.id, "Sources added — rebuilding notes…");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Could not upload the files.",
      );
      setProcessing(false);
    }
  }
  async function addTranscript(
    session: Lecture,
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    const form = event.currentTarget,
      text = String(new FormData(form).get("transcript") ?? "").trim();
    if (!text) return;
    try {
      await upload(
        session.id,
        new File([text], "pasted-transcript.txt", { type: "text/plain" }),
      );
      form.reset();
      await processLecture(session.id, "Transcript added — rebuilding notes…");
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Could not add the transcript.",
      );
    }
  }
  async function redoNotes(session: Lecture, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = String(
      new FormData(event.currentTarget).get("synthesis_prompt") ?? "",
    ).trim();
    const { error } = await supabase
      .from("lectures")
      .update({ synthesis_prompt: prompt })
      .eq("id", session.id);
    if (error) return setStatus(error.message);
    try {
      await processLecture(session.id, "Rebuilding study notes…", true);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Could not rebuild the notes.",
      );
    }
  }
  async function rename(session: Lecture) {
    const title = window.prompt("Lecture name", session.title)?.trim();
    if (!title || title === session.title) return;
    const { error } = await supabase
      .from("lectures")
      .update({ title })
      .eq("id", session.id);
    if (error) return setStatus(error.message);
    await loadLectures();
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
  const stage =
    status.includes("Uploading") ||
    status.includes("Creating") ||
    status.includes("Starting")
      ? 1
      : status.includes("Transcribing")
        ? 2
        : status.includes("Writing")
          ? 4
          : status.includes("ready")
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
        <a className="brand" href="/">
          lectern
        </a>
        <span className="privacy">
          Signed in as {user} ·{" "}
          <button className="sign-out" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </span>
      </header>
      <section className="intro">
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
        </article>
        <article className="materials card">
          <div className="card-heading">
            <span>02</span>
            <p>Course materials</p>
          </div>
          <label className="dropzone">
            <input
              type="file"
              accept=".pdf,.pptx,.txt"
              multiple
              onChange={addFiles}
            />
            <strong>Drop slides here</strong>
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
            <ul>
              {files.map((file, index) => (
                <li key={`${file.name}-${index}`}>{file.name}</li>
              ))}
            </ul>
          )}
          <label className="materials-label" htmlFor="materials">
            Or paste material
          </label>
          <textarea
            id="materials"
            value={materials}
            onChange={(event) => setMaterials(event.target.value)}
            placeholder="Paste the syllabus, an outline, or lecture context…"
          />
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
          <label className="synthesis-prompt" htmlFor="note-prompt">
            Note preferences <small>optional</small>
          </label>
          <textarea
            id="note-prompt"
            value={notePrompt}
            maxLength={4000}
            onChange={(event) => setNotePrompt(event.target.value)}
            placeholder="For example: prioritize exam-ready definitions, use a Cornell-note layout, and include worked examples."
          />
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
      {lectures.length > 0 && (
        <section className="history">
          <p className="eyebrow">Saved sessions</p>
          <div className="saved-session-list">
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
                <strong>{session.title}</strong>
                <small>
                  {session.status === "done"
                    ? "Notes ready"
                    : session.status_message}
                </small>
                {session.estimated_cost_usd !== null && (
                  <small>
                    Estimated API cost: $
                    {Number(session.estimated_cost_usd).toFixed(4)}
                  </small>
                )}
                <div>
                  <button onClick={() => rename(session)}>Rename</button>
                  {session.notes && (
                    <button onClick={() => setNotes(session.notes ?? "")}>
                      Open notes
                    </button>
                  )}
                  <label className="add-slides">
                    <input
                      type="file"
                      accept=".pdf,.pptx,.txt"
                      multiple
                      onChange={(event) => addToLecture(session, event)}
                    />
                    Add slides
                  </label>
                  <label className="add-slides">
                    <input
                      type="file"
                      accept="audio/*,.m4a,.mp3,.wav,.webm"
                      multiple
                      onChange={(event) => addToLecture(session, event)}
                    />
                    Add audio
                  </label>
                </div>
                <details>
                  <summary>Paste transcript</summary>
                  <form onSubmit={(event) => addTranscript(session, event)}>
                    <textarea
                      name="transcript"
                      required
                      placeholder="Paste an additional lecture transcript…"
                    />
                    <button disabled={processing}>Add transcript</button>
                  </form>
                </details>
                <details>
                  <summary>Redo notes</summary>
                  <form onSubmit={(event) => redoNotes(session, event)}>
                    <textarea
                      name="synthesis_prompt"
                      maxLength={4000}
                      defaultValue={session.synthesis_prompt}
                      placeholder="Optional note preferences…"
                    />
                    <button disabled={processing}>Redo AI synthesis</button>
                    <small>Uses saved sources and transcript; no transcription.</small>
                  </form>
                </details>
              </article>
            ))}
          </div>
        </section>
      )}
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
                    .writeText(notes)
                    .then(() => setStatus("Notes copied to clipboard."))
                }
              >
                Copy all
              </button>
              <button onClick={() => setNotes("")}>Close</button>
            </div>
          </div>
          <article className="notes-content">
            <ReactMarkdown>{notes}</ReactMarkdown>
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
