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
    and note_runs < 2
    and status not in ('transcribing', 'synthesizing');
  if not found then raise exception 'This lecture is already processing or has used its one note redo.'; end if;
end $$;
