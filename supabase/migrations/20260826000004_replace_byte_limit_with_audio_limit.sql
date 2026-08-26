-- Audio duration is checked in the browser before upload. Keep a storage safety ceiling
-- and a separate, small cap for course materials, but do not reject audio by its byte size.
update storage.buckets set file_size_limit = 262144000 where id = 'lecture-files';

create or replace function public.check_lecture_sources()
returns trigger language plpgsql security definer set search_path = public, storage as $$
declare material_bytes bigint;
begin
  if not (lower(storage.extension(new.storage_path)) = any (array['mp3', 'm4a', 'wav', 'webm', 'ogg', 'aac', 'flac', 'pdf', 'pptx', 'txt'])) then raise exception 'Unsupported file type'; end if;
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
