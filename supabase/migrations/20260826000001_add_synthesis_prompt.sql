alter table public.lectures
  add column synthesis_prompt text not null default ''
  check (char_length(synthesis_prompt) <= 4000);
