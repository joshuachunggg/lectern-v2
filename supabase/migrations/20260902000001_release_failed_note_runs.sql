create or replace function public.release_note_run(p_lecture_id uuid, p_owner_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  update public.lectures set note_runs = greatest(note_runs - 1, 0)
  where id = p_lecture_id and owner_id = p_owner_id;
end $$;
