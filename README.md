# Lectern v2

Cloud version of Lectern. The original local v1 remains separate and unchanged.

## Setup

1. Create or select a Supabase project, then run `supabase link --project-ref YOUR_REF` and `supabase db push`.
2. Set the Edge Function secret: `supabase secrets set OPENAI_API_KEY=...`.
3. Deploy it: `supabase functions deploy process-lecture`.
4. Copy `.env.example` to `.env.local`, add the project URL and publishable key, then run `npm install && npm run dev`.

In Supabase Dashboard → Authentication → URL Configuration, add `http://localhost:5173/**` and any development tunnel URL you use to Redirect URLs. Set Site URL to `http://localhost:5173` while running locally.

The browser uploads to private Supabase Storage, Supabase Auth/RLS enforces ownership, and the Edge Function holds the OpenAI key. It transcribes audio with `gpt-4o-mini-transcribe` and generates notes with the Responses API.

Text materials are supported in this first cloud slice. PDF/PPTX extraction is intentionally deferred until the core cloud pipeline is live.
