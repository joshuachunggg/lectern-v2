# Lectern v2

Cloud version of Lectern. The original local v1 remains separate and unchanged.

## Setup

1. Create or select a Supabase project, then run `supabase link --project-ref YOUR_REF` and `supabase db push`.
2. In Stripe, create a $10/month recurring price and configure the Stripe customer portal. The plan includes 30 audio hours monthly; additional audio costs $0.50/hour from a prepaid $0.50–$100 balance.
3. Set Edge Function secrets: `supabase secrets set OPENAI_API_KEY=... STRIPE_SECRET_KEY=... STRIPE_BASE_PRICE_ID=price_... STRIPE_WEBHOOK_SECRET=whsec_...`.
4. Deploy the functions: `supabase functions deploy process-lecture billing stripe-webhook`.
5. Add a Stripe webhook endpoint at `https://YOUR_PROJECT.supabase.co/functions/v1/stripe-webhook` for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.paid`.
4. Copy `.env.example` to `.env.local`, add the project URL and publishable key, then run `npm install && npm run dev`.

In Supabase Dashboard → Authentication → URL Configuration, add `http://localhost:5173/**` and `https://app.getlectern.app/**` to Redirect URLs. Set the Site URL to `https://app.getlectern.app` after its first deployment.

The browser uploads to private Supabase Storage, Supabase Auth/RLS enforces ownership, and the Edge Function holds the OpenAI and Stripe keys. Each account receives one free lecture; the $10/month subscription includes 30 audio hours, then additional audio costs $0.50/hour from a non-expiring prepaid balance. A lecture is limited to 12 approved source files, 90 minutes of audio, and 5 MB of course materials; pasted text is capped at 100,000 characters and custom preferences at 1,500 characters. Storage also has a 250 MB per-file safety ceiling. It transcribes audio with `gpt-transcribe` and generates notes with the Responses API.

## Optional Groq transcription test

OpenAI remains the default. To test Groq Whisper Large V3, set `GROQ_API_KEY=... TRANSCRIPTION_PROVIDER=groq` with `supabase secrets set`, then redeploy `process-lecture`. Revert by setting `TRANSCRIPTION_PROVIDER=openai` and redeploying; no data migration or code change is involved.

Text materials are supported in this first cloud slice. PDF/PPTX extraction is intentionally deferred until the core cloud pipeline is live.
