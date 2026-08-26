# Lectern v2

Cloud version of Lectern. The original local v1 remains separate and unchanged.

## Setup

1. Create or select a Supabase project, then run `supabase link --project-ref YOUR_REF` and `supabase db push`.
2. In Stripe, create a $10/month recurring price and a $0.50 usage-based price. Attach the latter to a meter with event name `lectern_lecture`, customer key `stripe_customer_id`, value key `value`, and `Sum` aggregation. Configure the Stripe customer portal.
3. Set Edge Function secrets: `supabase secrets set OPENAI_API_KEY=... STRIPE_SECRET_KEY=... STRIPE_BASE_PRICE_ID=price_... STRIPE_OVERAGE_PRICE_ID=price_... STRIPE_WEBHOOK_SECRET=whsec_...`.
4. Deploy the functions: `supabase functions deploy process-lecture billing stripe-webhook`.
5. Add a Stripe webhook endpoint at `https://YOUR_PROJECT.supabase.co/functions/v1/stripe-webhook` for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.paid`.
4. Copy `.env.example` to `.env.local`, add the project URL and publishable key, then run `npm install && npm run dev`.

In Supabase Dashboard → Authentication → URL Configuration, add `http://localhost:5173/**` and `https://joshuachunggg.github.io/lectern-v2/**` to Redirect URLs. Set the Site URL to the GitHub Pages URL after its first deployment.

The browser uploads to private Supabase Storage, Supabase Auth/RLS enforces ownership, and the Edge Function holds the OpenAI and Stripe keys. Each account receives one free lecture; the $10/month subscription includes 24 lectures, then Stripe meters $0.50 per lecture. A lecture is limited to 12 approved source files, 90 minutes of audio, and 5 MB of course materials; pasted text is capped at 100,000 characters and custom preferences at 1,500 characters. Storage also has a 250 MB per-file safety ceiling. It transcribes audio with `gpt-transcribe` and generates notes with the Responses API.

## Optional Groq transcription test

OpenAI remains the default. To test Groq Whisper Large V3, set `GROQ_API_KEY=... TRANSCRIPTION_PROVIDER=groq` with `supabase secrets set`, then redeploy `process-lecture`. Revert by setting `TRANSCRIPTION_PROVIDER=openai` and redeploying; no data migration or code change is involved.

Text materials are supported in this first cloud slice. PDF/PPTX extraction is intentionally deferred until the core cloud pipeline is live.
