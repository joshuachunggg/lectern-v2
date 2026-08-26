alter table public.lectures
  add column api_usage jsonb not null default '{}'::jsonb,
  add column estimated_cost_usd numeric(12, 6);
