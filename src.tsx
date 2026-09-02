import { createClient } from "@supabase/supabase-js";
import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";
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
const NOTE_DETAIL = ["Most concise", "Concise", "Balanced", "Detailed", "Most comprehensive"] as const;
const MAX_COURSE_MATERIAL_BYTES = 5 * 1024 * 1024;
const materialSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const MAX_AUDIO_SECONDS = 90 * 60;
const MAX_TRANSCRIPTION_FILE_BYTES = 24 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "webm", "ogg", "aac", "flac"]);
const DRAFT_DB = "lectern-recording-draft";
type RecordingDraft = { audio: Blob; title: string; slideMode: SlideMode; seconds: number };
const draftDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DRAFT_DB, 1);
  request.onupgradeneeded = () => request.result.createObjectStore("recording", { keyPath: "id" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const draftTransaction = async (mode: IDBTransactionMode, run: (store: IDBObjectStore) => void) => {
  const database = await draftDatabase(), transaction = database.transaction("recording", mode);
  run(transaction.objectStore("recording"));
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
};
const startDraft = (draft: Omit<RecordingDraft, "audio">, audio?: Blob) =>
  draftTransaction("readwrite", store => { store.clear(); store.put({ id: "meta", ...draft }); if (audio) store.put({ id: "chunk-000000", audio }); });
const appendDraft = (index: number, audio: Blob, seconds: number, draft: Omit<RecordingDraft, "audio" | "seconds">) =>
  draftTransaction("readwrite", store => { store.put({ id: `chunk-${String(index).padStart(6, "0")}`, audio }); store.put({ id: "meta", ...draft, seconds }); });
const clearDraft = () => draftTransaction("readwrite", store => store.clear());
const loadDraft = async (): Promise<RecordingDraft | null> => {
  const database = await draftDatabase(), transaction = database.transaction("recording"), request = transaction.objectStore("recording").getAll();
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      database.close();
      const meta = request.result.find(entry => entry.id === "meta"), chunks = request.result.filter(entry => entry.audio).map(entry => entry.audio as Blob);
      resolve(meta && chunks.length ? { audio: new Blob(chunks, { type: chunks[0].type }), title: meta.title, slideMode: meta.slideMode, seconds: meta.seconds } : null);
    };
    request.onerror = () => { database.close(); reject(request.error); };
  });
};
const audioDuration = (file: File) => new Promise<number>((resolve, reject) => {
  const audio = document.createElement("audio"), url = URL.createObjectURL(file);
  let settled = false;
  const finish = (duration?: number) => {
    if (settled) return;
    settled = true;
    URL.revokeObjectURL(url);
    Number.isFinite(duration) ? resolve(duration!) : reject(new Error(`Could not read ${file.name}.`));
  };
  audio.onloadedmetadata = () => Number.isFinite(audio.duration) ? finish(audio.duration) : audio.currentTime = 1e101;
  audio.ondurationchange = () => Number.isFinite(audio.duration) && finish(audio.duration);
  audio.onerror = () => finish();
  audio.src = url;
});
const isAudio = (file: File) => AUDIO_EXTENSIONS.has(file.name.toLowerCase().split(".").pop() ?? "");
const isMaterial = (file: File) => ["pdf", "txt"].includes(file.name.toLowerCase().split(".").pop() ?? "");
const isPowerPoint = (file: File) => ["ppt", "pptx"].includes(file.name.toLowerCase().split(".").pop() ?? "");
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
const clock = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
type SlideMode = "text" | "original";
type Lecture = {
  id: string;
  title: string;
  slide_mode: SlideMode;
  status: string;
  status_message: string;
  transcript: string | null;
  notes: string | null;
  synthesis_prompt: string;
  note_detail: number;
  note_runs: number;
  deleted_at: string | null;
};
type SavedPrompt = { id: string; name: string; prompt: string };
type MaterialSource = { id: string; storage_path: string; filename: string; size: number };
type Billing = { active: boolean; included_seconds: number; overage_seconds: number; credit_cents: number; free_used: boolean; cancel_at: string | null };

function App() {
  const marketingAppUrl = import.meta.env.VITE_APP_URL as string | undefined;
  const recorder = useRef<MediaRecorder | null>(null),
    timer = useRef<ReturnType<typeof setInterval> | null>(null),
    copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    profileMenu = useRef<HTMLDetailsElement | null>(null),
    notesDialog = useRef<HTMLDialogElement | null>(null),
    contentDialog = useRef<HTMLDialogElement | null>(null),
    promptDialog = useRef<HTMLDialogElement | null>(null),
    pricingDialog = useRef<HTMLDialogElement | null>(null),
    submitting = useRef(false);
  const [user, setUser] = useState<string | null>(null),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [authError, setAuthError] = useState(""),
    [showAuth, setShowAuth] = useState(() => window.location.hash === "#sign-in"),
    [page, setPage] = useState(() => window.location.hash === "#saved-sessions" ? "saved" : window.location.hash === "#manage-plan" ? "plan" : "new"),
    [billing, setBilling] = useState<Billing | null>(null),
    [lectures, setLectures] = useState<Lecture[]>([]),
    [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]),
    [lecture, setLecture] = useState("Untitled lecture"),
    [slideMode, setSlideMode] = useState<SlideMode>("text"),
    [recording, setRecording] = useState(false),
    [recordingPaused, setRecordingPaused] = useState(false),
    [restoredRecording, setRestoredRecording] = useState(false),
    [seconds, setSeconds] = useState(0),
    [audio, setAudio] = useState<Blob | null>(null),
    [audioUrl, setAudioUrl] = useState(""),
    [audioFiles, setAudioFiles] = useState<File[]>([]),
    [recordingDraft, setRecordingDraft] = useState<RecordingDraft | null>(null),
    [files, setFiles] = useState<File[]>([]),
    [draggingMaterials, setDraggingMaterials] = useState(false),
    [materials, setMaterials] = useState(""),
    [notePrompt, setNotePrompt] = useState(""),
    [noteDetail, setNoteDetail] = useState(4),
    [promptName, setPromptName] = useState(""),
    [contentSession, setContentSession] = useState<Lecture | null>(null),
    [contentSources, setContentSources] = useState<MaterialSource[]>([]),
    [removedContentSources, setRemovedContentSources] = useState<string[]>([]),
    [contentFiles, setContentFiles] = useState<File[]>([]),
    [contentText, setContentText] = useState(""),
    [contentNotePrompt, setContentNotePrompt] = useState(""),
    [contentPromptName, setContentPromptName] = useState(""),
    [contentNoteDetail, setContentNoteDetail] = useState(4),
    [editingTitle, setEditingTitle] = useState<string | null>(null),
    [titleDraft, setTitleDraft] = useState(""),
    [status, setStatus] = useState("Add lecture audio to begin"),
    [processing, setProcessing] = useState(false),
    [creditAmount, setCreditAmount] = useState("5.00"),
    [overageNotice, setOverageNotice] = useState(""),
    [notes, setNotes] = useState(""),
    [transcript, setTranscript] = useState(""),
    [showTranscript, setShowTranscript] = useState(false),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    const closeProfile = (event: PointerEvent) => {
      if (profileMenu.current?.open && !profileMenu.current.contains(event.target as Node)) profileMenu.current.open = false;
    };
    document.addEventListener("pointerdown", closeProfile);
    return () => document.removeEventListener("pointerdown", closeProfile);
  }, []);
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
    if (!data) return null;
    const next = data as Billing;
    setBilling(next);
    return next;
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
  useEffect(() => { loadDraft().then(setRecordingDraft).catch(() => {}); }, []);
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
  const openNotes = (session: Pick<Lecture, "notes" | "transcript">) => {
    setTranscript(session.transcript ?? "");
    setShowTranscript(false);
    setNotes(session.notes ?? "");
  };
  const copyToClipboard = (text: string, message: string) =>
    navigator.clipboard.writeText(text).then(() => {
      setStatus(message); setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1400);
    });
  async function addOverageFunds() {
    const creditCents = Math.round(Number(creditAmount) * 100);
    if (!/^\d+(?:\.\d{1,2})?$/.test(creditAmount) || creditCents < 50 || creditCents > 10_000) return setStatus("Enter an amount from $0.50 to $100.00.");
    const { data, error } = await supabase.functions.invoke("billing", { body: { action: "credit_checkout", creditCents, returnUrl: `${window.location.origin}${window.location.pathname}#manage-plan` } });
    if (error || !data?.url) return setStatus(error?.message ?? "Could not open checkout.");
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
    const sourceType = file.type.startsWith("audio/") || AUDIO_EXTENSIONS.has(file.name.toLowerCase().split(".").pop() ?? "") ? "audio" : "material";
    const { error } = await supabase.from("lecture_sources").insert({
      lecture_id: id,
      storage_path: path,
      filename: file.name,
      content_type: file.type || "application/octet-stream",
      source_type: sourceType,
      duration_seconds: sourceType === "audio" ? Math.ceil(await audioDuration(file)) : null,
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
    setNotes(""); setTranscript(""); setShowTranscript(false);
    setStatus(message);
    let poll: ReturnType<typeof window.setInterval> | undefined;
    try {
      if (!synthesizeOnly) await chunkStoredAudio(id);
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
        .select("notes,status_message,transcript")
        .eq("id", id)
        .single();
      if (data?.notes) openNotes(data);
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } }), chunks: Blob[] = audio ? [audio] : [], next = new MediaRecorder(stream, { audioBitsPerSecond: 32000 });
      let chunkIndex = audio ? 1 : 0, recordedSeconds = seconds;
      await startDraft({ title: lecture, slideMode, seconds }, audio ?? undefined).catch(() => {});
      next.ondataavailable = (event) => {
        if (!event.data.size) return;
        chunks.push(event.data);
        void appendDraft(chunkIndex++, event.data, recordedSeconds, { title: lecture, slideMode }).catch(() => {});
      };
      next.onstop = () => {
        const saved = new Blob(chunks, { type: next.mimeType });
        setAudio(saved); setAudioUrl(URL.createObjectURL(saved));
        stream.getTracks().forEach((track) => track.stop());
        if (timer.current) clearInterval(timer.current);
        setRecording(false); setRecordingPaused(false); setRestoredRecording(false); void clearDraft().catch(() => {}); void saveRecording(saved);
      };
      recorder.current = next; next.start(1000); if (!audio) setSeconds(0);
      timer.current = setInterval(() => setSeconds((value) => { recordedSeconds = value + 1; if (recordedSeconds >= MAX_AUDIO_SECONDS) { next.stop(); return MAX_AUDIO_SECONDS; } return recordedSeconds; }), 1000);
      setRestoredRecording(false); setRecording(true); setStatus("Recording");
    } catch { setStatus("Microphone access is required to record."); }
  }
  async function saveRecording(recording: Blob) {
    setProcessing(true); setStatus("Saving recording…");
    try {
      const { data: session, error } = await supabase.from("lectures").insert({ title: lecture, slide_mode: slideMode }).select().single();
      if (error || !session) throw error ?? new Error("Could not save the recording.");
      await upload(session.id, new File([recording], "recording.webm", { type: recording.type || "audio/webm" }));
      setAudio(null); await loadLectures(); setStatus("Recording saved — continue from Saved sessions.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save the recording.");
    } finally { setProcessing(false); }
  }
  function toggleRecordingPause() {
    const current = recorder.current;
    if (!current) return;
    if (current.state === "recording") {
      current.pause(); if (timer.current) clearInterval(timer.current);
      setRecordingPaused(true); setStatus("Recording paused");
    } else if (current.state === "paused") {
      current.resume();
      timer.current = setInterval(() => setSeconds((value) => { if (value + 1 >= MAX_AUDIO_SECONDS) { current.stop(); return MAX_AUDIO_SECONDS; } return value + 1; }), 1000);
      setRecordingPaused(false); setStatus("Recording");
    }
  }
  function restoreRecordingDraft() {
    if (!recordingDraft) return;
    setLecture(recordingDraft.title); setSlideMode(recordingDraft.slideMode); setSeconds(recordingDraft.seconds); setRestoredRecording(true);
    setAudio(recordingDraft.audio); setAudioUrl(URL.createObjectURL(recordingDraft.audio));
    setRecordingDraft(null); setStatus("Recording restored — continue recording or make notes.");
    void clearDraft().catch(() => {});
  }
  function queueMaterials(added: File[]) {
    const accepted = added.filter(isMaterial), rejected = added.filter((file) => !isMaterial(file));
    if (!accepted.length) return setStatus(rejected.some(isPowerPoint) ? "PowerPoint files aren’t supported. Export them as PDFs before uploading." : "Upload a PDF or plain-text file.");
    setFiles((current) => {
      const next = [...current, ...accepted];
      if (next.reduce((total, file) => total + file.size, 0) > MAX_COURSE_MATERIAL_BYTES) {
        setStatus("Lecture slides can total at most 5 MB.");
        return current;
      }
      setStatus(`${accepted.length} slide file${accepted.length === 1 ? "" : "s"} ready${rejected.length ? " — export PowerPoint files as PDFs before uploading." : ""}`);
      return next;
    });
  }
  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    queueMaterials(Array.from(event.target.files ?? []));
    event.target.value = "";
  }
  function dropMaterials(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDraggingMaterials(false);
    queueMaterials(Array.from(event.dataTransfer.files));
  }
  function leaveMaterialDropzone(event: DragEvent<HTMLLabelElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setDraggingMaterials(false);
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
  function removeAudio(index: number) {
    setAudioFiles((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }
  async function makeNotes() {
    const sources = [
      ...(audio ? [new File([audio], "recording.webm", { type: audio.type || "audio/webm" })] : []),
      ...audioFiles,
      ...files,
      ...(materials.trim()
        ? [new File([materials], "pasted-material.txt", { type: "text/plain" })]
        : []),
    ];
    if (!sources.some(isAudio)) return setStatus("Upload lecture audio before making study notes.");
    if (files.reduce((total, file) => total + file.size, 0) > MAX_COURSE_MATERIAL_BYTES)
      return setStatus("Lecture slides can total at most 5 MB.");
    const audioSeconds = (await Promise.all(sources.filter(isAudio).map(audioDuration))).reduce((total, seconds) => total + seconds, 0);
    if (audioSeconds > MAX_AUDIO_SECONDS)
      return setStatus("A lecture can contain at most 90 minutes of audio.");
    if (notePrompt.length > MAX_PROMPT_CHARS)
      return setStatus("Custom note preferences are limited to 1,500 characters.");
    const currentBilling = billing ?? await loadBilling();
    const includedSeconds = Math.max(0, 108000 - (currentBilling?.included_seconds ?? 0));
    const requiredCreditCents = Math.ceil(Math.max(0, MAX_AUDIO_SECONDS - Math.min(MAX_AUDIO_SECONDS, includedSeconds)) * 50 / 3600);
    if (currentBilling?.active && audioSeconds > includedSeconds && currentBilling.credit_cents < requiredCreditCents) {
      setCreditAmount((requiredCreditCents / 100).toFixed(2));
      setOverageNotice(`This lecture may use overage. Add at least $${(requiredCreditCents / 100).toFixed(2)} in credit before starting; unused credit stays on your balance.`);
      window.location.hash = "#manage-plan";
      return;
    }
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
          note_detail: noteDetail,
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
      setAudio(null); setAudioUrl("");
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
  const contentMaterialBytes = () => contentSources.filter((source) => !removedContentSources.includes(source.id)).reduce((total, source) => total + source.size, 0) + contentFiles.reduce((total, file) => total + file.size, 0) + new Blob([contentText]).size;
  async function openContent(session: Lecture) {
    try {
      const { data: sources, error } = await supabase.from("lecture_sources").select("id,storage_path,filename,source_type").eq("lecture_id", session.id).eq("source_type", "material");
      if (error) throw error;
      const { data: stored, error: storageError } = await supabase.storage.from("lecture-files").list(session.id, { limit: 100 });
      if (storageError) throw storageError;
      const pasted = (sources ?? []).filter((source) => source.filename === "pasted-material.txt");
      const pastedText = await Promise.all(pasted.map(async (source) => {
        const { data, error } = await supabase.storage.from("lecture-files").download(source.storage_path);
        if (error || !data) throw error ?? new Error("Could not load pasted slide text.");
        return data.text();
      }));
      const sizes = new Map((stored ?? []).map((file) => [file.name, Number(file.metadata?.size ?? 0)]));
      setContentSession(session);
      setContentSources((sources ?? []).map((source) => ({ ...source, size: sizes.get(source.storage_path.split("/").slice(1).join("/")) ?? 0 })));
      setRemovedContentSources(pasted.map((source) => source.id)); setContentFiles([]); setContentText(pastedText.join("\n\n")); setContentPromptName("");
      setContentNotePrompt(session.synthesis_prompt ?? ""); setContentNoteDetail(session.note_detail ?? 4);
      contentDialog.current?.showModal();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not load lecture slides."); }
  }
  function queueContentFiles(added: File[]) {
    const accepted = added.filter(isMaterial);
    if (!accepted.length) return setStatus(added.some(isPowerPoint) ? "PowerPoint files aren’t supported. Export them as PDFs before uploading." : "Upload a PDF or plain-text file.");
    if (contentMaterialBytes() + accepted.reduce((total, file) => total + file.size, 0) > MAX_COURSE_MATERIAL_BYTES) return setStatus("Lecture slides can total at most 5 MB.");
    setContentFiles((current) => [...current, ...accepted]);
  }
  async function redoWithSlides() {
    if (!contentSession) return;
    if (contentMaterialBytes() > MAX_COURSE_MATERIAL_BYTES) return setStatus("Lecture slides can total at most 5 MB.");
    try {
      setProcessing(true);
      const removed = contentSources.filter((source) => removedContentSources.includes(source.id));
      if (removed.length) {
        const { error } = await supabase.from("lecture_sources").delete().in("id", removed.map((source) => source.id));
        if (error) throw error;
        await supabase.storage.from("lecture-files").remove(removed.map((source) => source.storage_path));
      }
      const added = [...contentFiles, ...(contentText.trim() ? [new File([contentText.trim()], "pasted-material.txt", { type: "text/plain" })] : [])];
      setStatus(`Updating slides for ${contentSession.title}…`);
      for (const file of added) await upload(contentSession.id, file);
      const { error } = await supabase.from("lectures").update({ synthesis_prompt: contentNotePrompt.trim(), note_detail: contentNoteDetail }).eq("id", contentSession.id);
      if (error) throw error;
      contentDialog.current?.close();
      await processLecture(contentSession.id, "Rebuilding study notes…", true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not rebuild the notes.");
      setProcessing(false);
    }
  }
  function openPrompt() {
    setPromptName("");
    promptDialog.current?.showModal();
  }
  async function savePrompt(nameValue: string, promptValue: string, clear: () => void) {
    const name = nameValue.trim(), prompt = promptValue.trim();
    if (!name || !prompt) return;
    if (prompt.length > MAX_PROMPT_CHARS)
      return setStatus("Custom note preferences are limited to 1,500 characters.");
    const { error } = await supabase.from("saved_prompts").insert({ name, prompt });
    if (error) return setStatus(error.message);
    clear();
    await loadSavedPrompts();
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
    if (!window.confirm(`Move “${session.title}” to Recently deleted? You can restore it for 30 days.`))
      return;
    const { error } = await supabase.from("lectures").update({ deleted_at: new Date().toISOString() }).eq("id", session.id);
    if (error) return setStatus(error.message);
    setNotes("");
    setStatus(`Moved ${session.title} to Recently deleted.`);
    await loadLectures();
  }
  async function restoreLecture(session: Lecture) {
    const { error } = await supabase.from("lectures").update({ deleted_at: null }).eq("id", session.id);
    if (error) return setStatus(error.message);
    setStatus(`Restored ${session.title}.`);
    await loadLectures();
  }
  const canProcess = Boolean(audio || audioFiles.length);
  const activeLectures = lectures.filter((session) => !session.deleted_at);
  const recentlyDeleted = lectures.filter((session) => session.deleted_at && Date.now() - new Date(session.deleted_at).getTime() < 30 * 24 * 60 * 60 * 1000);
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
  const openApp = () => marketingAppUrl ? window.location.assign(`${marketingAppUrl}#sign-in`) : setShowAuth(true);

  if (!user && !showAuth)
    return (
      <main className="landing">
        <header className="landing-header">
          <a className="brand" href="#top">lectern</a>
          <button className="landing-sign-in" onClick={openApp}>Sign in</button>
        </header>
        <section className="landing-hero" id="top">
          <div className="landing-hero-copy">
            <p className="eyebrow">A calmer way to learn</p>
            <h1>Never choose between listening and taking notes.</h1>
            <p>Lectern captures your lecture and turns it into clear, organized study notes—so you can stay present and know the important parts are there when you need them.</p>
            <button onClick={openApp}>Create a free account</button>
            <small>Your first lecture is free. No card required.</small>
          </div>
          <aside className="hero-preview" aria-label="Example of finished study notes">
            <div className="hero-preview-inner">
              <div className="preview-bar"><span>Lecture 04</span><span className="preview-dot" /></div>
              <p className="preview-title">Study notes, ready when you are.</p>
              <div className="preview-line accent" /><div className="preview-line" /><div className="preview-line short" />
              <div className="preview-tags"><span>Key concepts</span><span>Review</span></div>
            </div>
          </aside>
        </section>
        <section className="landing-section">
          <div className="landing-section-heading"><p className="eyebrow">How it works</p><h2>Stay present. Nothing gets lost.</h2></div>
          <ol className="landing-steps">
            <li><strong>Record or upload</strong><span>Add one recording, or capture the lecture as it happens.</span></li>
            <li><strong>Set the context</strong><span>Include lecture slides and the note format that helps you study.</span></li>
            <li><strong>Study with clarity</strong><span>Receive a transcript and structured notes built around the lecture.</span></li>
          </ol>
        </section>
        <section className="landing-plan">
          <div><p className="eyebrow">One honest plan</p><h2>$10 / month</h2><p>30 audio hours each month—about 24 seventy-five-minute lectures.</p></div>
          <dl><div><dt>Included time</dt><dd>30 hours</dd></div><div><dt>After that</dt><dd>$0.50 / hour</dd></div><div><dt>Always included</dt><dd>Transcripts, notes, and custom instructions</dd></div></dl>
          <p className="landing-overage">Overage is prepaid only when you need it. Any unused balance remains yours.</p>
          <button onClick={openApp}>Start with a free lecture</button>
        </section>
      </main>
    );
  if (!user)
    return (
      <main className="auth">
        <button className="brand auth-back" onClick={() => setShowAuth(false)}>
          lectern
        </button>
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
        <details className="profile" ref={profileMenu}>
          <summary><span>{user}</span><small>{billing?.active ? "Paid plan" : "Free plan"}</small></summary>
          <div>
            <p>{billing?.active ? billing.included_seconds < 108000 ? `${Math.max(0, 30 - billing.included_seconds / 3600).toFixed(1)} audio hours remaining` : `$${((billing.credit_cents ?? 0) / 100).toFixed(2)} overage balance` : `${billing?.free_used ? 0 : 1} free lecture remaining`}</p>
            {!billing?.active && <button className="upgrade-plan" onClick={() => pricingDialog.current?.showModal()}>Upgrade</button>}
            {billing?.active && <a className="sign-out" href="#manage-plan">Manage plan</a>}
            <button className="sign-out" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        </details>
      </header>
      {page === "plan" && <section className="plan" id="manage-plan">
        <p className="eyebrow">Manage plan</p>
        <h1>{billing?.active ? "Lectern plan" : "Free plan"}</h1>
        {billing?.active ? <>
          <p>Includes 30 audio hours each month. Overage audio is $0.50 per hour and uses your non-expiring balance.</p>
          {billing.cancel_at && <p className="cancel-notice">Your plan cancels on {new Date(billing.cancel_at).toLocaleDateString()}.</p>}
          {overageNotice && <p className="overage-notice" role="status">{overageNotice}</p>}
          <dl><div><dt>Included audio remaining</dt><dd>{Math.max(0, 30 - billing.included_seconds / 3600).toFixed(1)} hr</dd></div><div><dt>Overage balance</dt><dd>${(billing.credit_cents / 100).toFixed(2)}</dd></div></dl>
          <div className="refill">
            <div><strong>Add overage funds</strong><small>Any amount from $0.50 to $100.</small></div>
            <label className="credit-amount"><span>$</span><input aria-label="Overage fund amount" type="number" min="0.50" max="100" step="0.01" inputMode="decimal" value={creditAmount} onChange={event => setCreditAmount(event.target.value)} /></label>
            <button onClick={addOverageFunds}>Add funds</button>
          </div>
          <button className="manage-subscription" onClick={openStripeBilling}>Manage subscription in Stripe</button>
        </> : <>
          <p>Your first lecture is free. The Lectern plan is $10/month and includes 30 audio hours. Overage audio costs $0.50 per hour from a prepaid balance.</p>
          <button onClick={() => pricingDialog.current?.showModal()}>View upgrade options</button>
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
        <article className="audio-card card">
          <div className="card-heading">
            <span>01</span>
            <p>Lecture audio</p>
          </div>
          <div className="card-body">
            <div className={`upload-mark ${recording || restoredRecording ? "live" : ""}`} aria-hidden="true">♫</div>
            <h2>Record or upload audio</h2>
            <p>Record in Lectern or choose recordings from your device.</p>
            <p className="status" aria-live="polite">
              {status}
            </p>
            <button className={`recording-control ${recording ? "stop" : ""}`} onClick={toggleRecording}>
              {recording ? `Stop recording · ${clock(seconds)}` : restoredRecording ? `Continue recording · ${clock(seconds)}` : "Start recording"}
            </button>
            {recording && <button className="secondary-action recording-control" onClick={toggleRecordingPause}>{recordingPaused ? "Resume recording" : "Pause recording"}</button>}
            <label className="audio-upload">
              <input
                type="file"
                accept="audio/*,.m4a,.mp3,.wav,.webm"
                multiple
                onChange={addAudio}
              />
              <span>Choose audio files</span>
            </label>
            {recordingDraft && <button className="restore-recording" onClick={restoreRecordingDraft}>Restore last saved session?</button>}
            {audioFiles.length > 0 && (
              <div className="file-queue audio-queue">
                <div className="file-queue-heading"><strong>{audioFiles.length} audio file{audioFiles.length === 1 ? "" : "s"} ready</strong><button type="button" onClick={() => setAudioFiles([])}>Clear all</button></div>
                <ul>
                  {audioFiles.map((file, index) => (
                    <li key={`${file.name}-${index}`}><span className="file-icon" aria-hidden="true">♫</span><span className="file-details"><strong>{file.name}</strong><small>Lecture {String(index + 1).padStart(2, "0")} · {materialSize(file.size)}</small></span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeAudio(index)}>Remove</button></li>
                  ))}
                </ul>
              </div>
            )}
            {audioUrl && <audio controls src={audioUrl}>Your browser cannot play this recording.</audio>}
          </div>
        </article>
        <article className="materials card">
          <div className="card-heading">
            <span>02</span>
            <p>Lecture slides</p>
          </div>
          <div className="card-body">
            <label className={`material-dropzone${draggingMaterials ? " is-dragging" : ""}`} onDragEnter={() => setDraggingMaterials(true)} onDragOver={(event) => event.preventDefault()} onDragLeave={leaveMaterialDropzone} onDrop={dropMaterials}>
              <input
                type="file"
                accept=".pdf,.txt"
                multiple
                onChange={addFiles}
              />
              <span aria-hidden="true">▤</span>
              <strong>Drop lecture slides here</strong>
              <small>or choose a PDF or plain-text slide notes</small>
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
              <div className="file-queue material-queue">
                <strong>Lecture slides</strong>
                <ul>
                  {files.map((file, index) => (
                    <li key={`${file.name}-${index}`}><span className="file-icon" aria-hidden="true">▤</span><span className="file-details"><strong>{file.name}</strong><small>{materialSize(file.size)}</small></span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeMaterial(index)}>Remove</button></li>
                  ))}
                </ul>
              </div>
            )}
            <label className="materials-label" htmlFor="materials">
              Or paste slide text
            </label>
            <textarea
              id="materials"
              value={materials}
              maxLength={100000}
              onChange={(event) => setMaterials(event.target.value)}
              placeholder="Paste slide text or lecture context…"
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
          <button className="secondary-action" onClick={openPrompt}>
            {notePrompt ? "Edit custom note prompt" : "Add custom note prompt"}
          </button>
          <label className="note-detail">
            <span>Note depth <strong>{NOTE_DETAIL[noteDetail - 1]}</strong></span>
            <input aria-label="Note depth" type="range" min="1" max="5" value={noteDetail} onChange={(event) => setNoteDetail(Number(event.target.value))} />
            <small>Most concise <span>Most comprehensive</span></small>
          </label>
          <div className="progress" aria-live="polite">
            <strong>{status}</strong>
            <ol>
              {[
                "Upload source files",
                "Transcribe lecture",
                "Read lecture slides",
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
              ? "Your lecture audio is ready."
              : "Upload lecture audio to continue."}
          </small>
        </article>
      </section>
      </>}
      {page === "saved" && (
        <section className="history" id="saved-sessions">
          <p className="eyebrow">Saved sessions</p>
          {activeLectures.length ? <div className="saved-session-list">
            {activeLectures.map((session) => (
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
                    <button onClick={() => openNotes(session)}>
                      Open notes
                    </button>
                  )}
                  {session.status === "ready" && !session.notes ? (
                    <button disabled={processing} onClick={() => processLecture(session.id, "Starting transcription…").catch(() => {})}>Make study notes</button>
                  ) : session.status === "error" && session.status_message === "Upload lecture audio before making study notes." ? (
                    <button disabled>Audio required</button>
                  ) : session.status === "error" ? (
                    <button disabled={processing} onClick={() => processLecture(session.id, "Retrying processing…").catch(() => {})}>Retry processing</button>
                  ) : session.note_runs < 2 ? (
                    <button onClick={() => openContent(session)}>Edit slides & redo notes</button>
                  ) : (
                    <button disabled>Redo already used</button>
                  )}
                </div>
              </article>
            ))}
          </div>
          : <p className="empty-sessions">No saved sessions yet.</p>}
          {recentlyDeleted.length > 0 && <details className="recently-deleted"><summary>Recently deleted ({recentlyDeleted.length})</summary>{recentlyDeleted.map((session) => <div key={session.id}><span>{session.title}</span><button onClick={() => restoreLecture(session)}>Restore</button></div>)}</details>}
        </section>
      )}
      <dialog className="modal redo-modal" ref={contentDialog}>
        <form onSubmit={(event) => { event.preventDefault(); void redoWithSlides(); }}>
          <div className="modal-heading">
            <h2>Edit slides & redo notes</h2>
            <button type="button" onClick={() => contentDialog.current?.close()}>
              Close
            </button>
          </div>
          <label>
            Add lecture slides
            <input type="file" accept=".pdf,.txt" multiple onChange={(event) => { queueContentFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          </label>
          {(contentSources.filter((source) => !removedContentSources.includes(source.id)).length > 0 || contentFiles.length > 0) && <div className="file-queue material-queue"><strong>Included slides · {materialSize(contentMaterialBytes())} of 5.0 MB</strong><ul>
            {contentSources.filter((source) => !removedContentSources.includes(source.id)).map((source) => <li key={source.id}><span className="file-details"><strong>{source.filename}</strong><small>{materialSize(source.size)}</small></span><button type="button" onClick={() => setRemovedContentSources((current) => [...current, source.id])}>Remove</button></li>)}
            {contentFiles.map((file, index) => <li key={`${file.name}-${index}`}><span className="file-details"><strong>{file.name}</strong><small>{materialSize(file.size)}</small></span><button type="button" onClick={() => setContentFiles((current) => current.filter((_, currentIndex) => currentIndex !== index))}>Remove</button></li>)}
          </ul></div>}
          <label>
            Pasted slide text
            <textarea value={contentText} maxLength={100000} onChange={(event) => setContentText(event.target.value)} placeholder="Paste slide text or lecture context…" />
          </label>
          <label>Optional note instructions<textarea value={contentNotePrompt} maxLength={MAX_PROMPT_CHARS} onChange={(event) => setContentNotePrompt(event.target.value)} placeholder="For example: prioritize exam-ready definitions and worked examples." /></label>
          {savedPrompts.length > 0 && <div className="saved-prompts"><small>Saved prompts</small>{savedPrompts.map((prompt) => <button key={prompt.id} type="button" onClick={() => setContentNotePrompt(prompt.prompt)}>{prompt.name}</button>)}</div>}
          <div className="save-prompt"><input value={contentPromptName} onChange={(event) => setContentPromptName(event.target.value)} placeholder="Name this prompt" maxLength={100} /><button type="button" onClick={() => void savePrompt(contentPromptName, contentNotePrompt, () => setContentPromptName(""))} disabled={!contentPromptName.trim() || !contentNotePrompt.trim()}>Save prompt</button></div>
          <label className="note-detail"><span>Note depth <strong>{NOTE_DETAIL[contentNoteDetail - 1]}</strong></span><input aria-label="Note depth" type="range" min="1" max="5" value={contentNoteDetail} onChange={(event) => setContentNoteDetail(Number(event.target.value))} /><small>Most concise <span>Most comprehensive</span></small></label>
          <button disabled={processing}>Redo notes</button>
        </form>
      </dialog>
      <dialog className="modal prompt-modal" ref={promptDialog}>
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
          <button type="button" onClick={() => void savePrompt(promptName, notePrompt, () => setPromptName(""))} disabled={!promptName.trim() || !notePrompt.trim()}>
            Save prompt
          </button>
        </div>
        <button onClick={() => promptDialog.current?.close()}>Use this prompt</button>
      </dialog>
      <dialog className="modal pricing-modal" ref={pricingDialog}>
        <div className="modal-heading">
          <h2>Choose your plan</h2>
          <button type="button" onClick={() => pricingDialog.current?.close()}>Close</button>
        </div>
        <div className="pricing-options">
          <section><p className="eyebrow">Free</p><h3>Try one lecture</h3><p>Get one free lecture, including your finished study notes.</p></section>
          <section className="paid-plan"><p className="eyebrow">Lectern plan</p><h3>$10 / month</h3><p>30 audio hours each month. After that, audio is $0.50 per hour from your prepaid balance.</p><button onClick={openStripeBilling}>Upgrade to Lectern</button></section>
        </div>
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
              {transcript && <button onClick={() => setShowTranscript((value) => !value)}>{showTranscript ? "Show notes" : "Show transcript"}</button>}
              <span className="copy-control"><button onClick={() => copyToClipboard(showTranscript ? transcript : notes.replace(/^( +)([-*+]|\d+[.)]) /gm, (_, indent, marker) => `${" ".repeat(Math.ceil(indent.length / 4) * 4)}${marker} `).replace(/[ \t]+$/gm, ""), showTranscript ? "Transcript copied to clipboard." : "Notes copied to clipboard.")}>{showTranscript ? "Copy transcript" : "Copy all"}</button>{copied && <span className="copied-confirmation" role="status">Copied!</span>}</span>
              <button onClick={() => setNotes("")}>Close</button>
            </div>
          </div>
          {showTranscript ? <pre className="transcript-content">{transcript}</pre> : <article className="notes-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown></article>}
        </dialog>
      )}
      <footer>
        Audio and slides are saved privately while they are processed.
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
