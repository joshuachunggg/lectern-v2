alter table public.lectures
  add column note_runs smallint not null default 0 check (note_runs >= 0 and note_runs <= 3);

-- Clients may manage lecture content, but billing, processing, and model-output fields
-- are exclusively server-managed.
revoke insert, update on public.lectures from anon, authenticated;
grant insert (title, slide_mode, synthesis_prompt, note_detail) on public.lectures to authenticated;
grant update (title, slide_mode, synthesis_prompt, note_detail) on public.lectures to authenticated;
revoke update on public.lecture_sources from anon, authenticated;

create or replace function public.claim_note_run(p_lecture_id uuid, p_owner_id uuid, p_synthesize_only boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  update public.lectures
  set note_runs = note_runs + 1,
      status = case when p_synthesize_only then 'synthesizing' else 'transcribing' end,
      status_message = case when p_synthesize_only then 'Rebuilding study notes…' else 'Starting transcription…' end
  where id = p_lecture_id
    and owner_id = p_owner_id
    and note_runs < 3
    and status not in ('transcribing', 'synthesizing');
  if not found then raise exception 'This lecture is already processing or has reached its three note generations.'; end if;
end $$;

create or replace function public.check_lecture_sources()
returns trigger language plpgsql security definer set search_path = public, storage as $$
declare material_bytes bigint; extension text;
begin
  extension := lower(storage.extension(new.storage_path));
  if not (extension = any (array['mp3', 'm4a', 'wav', 'webm', 'ogg', 'aac', 'flac', 'pdf', 'pptx', 'txt'])) then raise exception 'Unsupported file type'; end if;
  if (extension = any (array['mp3', 'm4a', 'wav', 'webm', 'ogg', 'aac', 'flac'])) and new.source_type <> 'audio' then raise exception 'Audio files must be audio sources'; end if;
  if (extension = any (array['pdf', 'pptx', 'txt'])) and new.source_type <> 'material' then raise exception 'Course files must be material sources'; end if;
  if (select count(*) from public.lecture_sources where lecture_id = new.lecture_id) >= 12 then raise exception 'A lecture can contain at most 12 source files'; end if;
  if new.source_type = 'material' then
    select coalesce(sum(coalesce((objects.metadata ->> 'size')::bigint, 0)), 0) into material_bytes
    from public.lecture_sources sources join storage.objects on objects.name = sources.storage_path and objects.bucket_id = 'lecture-files'
    where sources.lecture_id = new.lecture_id and sources.source_type = 'material' and sources.storage_path <> new.storage_path;
    select material_bytes + coalesce((metadata ->> 'size')::bigint, 0) into material_bytes from storage.objects where bucket_id = 'lecture-files' and name = new.storage_path;
    if material_bytes > 5242880 then raise exception 'Course materials can total at most 5 MB'; end if;
  end if;
  return new;
end $$;
