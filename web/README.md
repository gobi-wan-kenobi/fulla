# Fulla for the web

The same Fulla household, in a browser: an installable web app (PWA) meant for
iPhones, talking to the same Supabase project, schema and RPCs as the Android
app. Nothing here has its own backend: every read and write goes through the
`public.fulla_*` functions in [`supabase/migrations`](../supabase/migrations),
with row-level security on, exactly as the Android client calls them
([docs/sync.md](../docs/sync.md)).

Next.js (App Router) · TypeScript · Tailwind · `@supabase/supabase-js` / `@supabase/ssr`.

## What it does today

- Email and password sign-in and sign-up (Supabase Auth).
- Create a household (proposed in Canadian dollars) or join one with an invite code.
- Add, edit and delete transactions (expense, income, transfer, refund) with
  categories, split equally between members when there are two or more.
  Rows are kept in the browser and synced with `fulla_sync_push` /
  `fulla_sync_pull`: they can be added offline and go up when the app is next online.
- History by month with totals, search and filters.
- Import bank files: OFX, QFX, QIF and CSV, recognised by their content, with a
  preview before anything is saved. A CSV column mapping can be saved per bank
  (an import profile, shared with the Android app). The same line imported twice
  gets the same id, so a file imported again adds nothing; a transaction id
  (FITID) repeated inside one OFX/QFX file is kept once. UTF-8, and
  Windows-1252 / ISO-8859-1 files, are read correctly.
- Categorisation of imported and typed transactions, in this order: the
  household's rules ("note contains … → category"), then a built-in list of
  common Canadian merchants (`src/lib/merchants.ts`, statement strings cleaned
  of store numbers, `*`, processor prefixes and "CITY ON"), then the optional
  categorizer model, then Other / Other income. Rules can be added, edited,
  paused and deleted in Settings → Categories, created from a transaction when
  its category is changed, and applied to what is still in Uncategorized or
  Other.
- Bulk changes in History: select transactions, move them to a category, or
  mark them fixed or flexible.
- Fixed and flexible spending: a category can be fixed (its transactions start
  fixed), each transaction can still differ, and History shows the month's
  fixed and flexible totals.
- Settings: members, invite codes, accounts, sign out.
- Installable: a web manifest, icons, and a service worker that caches the app
  shell (never Supabase requests).

The importers are a port of `core/…/importers` (Kotlin) to `src/lib/importers`,
with the Kotlin tests ported to `test/importers.test.ts`, and shared vectors
(category defaults, currencies, name normalisation, import ids) checked against
the files the Android build uses.

## Run it locally

You need Node 20+, Docker and the [Supabase CLI](https://supabase.com/docs/guides/cli).

```sh
cd web
npm install
npm run db:local     # supabase start + Fulla's migrations + web/.env.local
npm run dev          # http://localhost:3000
```

`npm run db:local` starts a local Supabase in Docker, bundles
`supabase/migrations` into `dist/setup.sql` (the same file a release ships) and
loads it, then writes `web/.env.local` with the local URL and anon key. Run it
again any time; migrations already applied are skipped. Email confirmation is
off locally, so a new account can sign in straight away.

If `supabase start` hangs on the auth container ("failed to connect to db"),
Docker's bridge traffic is being dropped by an old firewall rule; on Linux
`sudo iptables -I DOCKER-USER -i br-+ -j ACCEPT && sudo iptables -I DOCKER-USER -o br-+ -j ACCEPT`
then `supabase stop --no-backup && supabase start` fixes it.

Checks, the same as CI:

```sh
npm run lint
npm run typecheck
npm test            # vitest
npm run build
```

## Deploy on Vercel

1. Set up the database once: apply Fulla's migrations to your Supabase project
   ([docs/self-hosting.md](../docs/self-hosting.md): `npm run db:bundle` at the
   repository root and run `dist/setup.sql`, or `npm run db:migrate`).
2. In Supabase → Authentication → Sign In / Providers → Email, turn **Confirm
   email** off (or configure SMTP so confirmation mails arrive).
3. In Supabase → Authentication → URL Configuration, set **Site URL** to the
   Vercel address (for example `https://fulla.vercel.app`) and add it to the
   redirect URLs.
4. Import this repository in Vercel with **Root Directory** `web`
   (framework preset Next.js, the defaults for build and output).
5. Environment variables (Production and Preview):

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the project's anon key or publishable key (`sb_publishable_…`) |

   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is read too, if you prefer that name.

   Optional, server-side only (never `NEXT_PUBLIC_`): the categorizer model.

   | Name | Value |
   | --- | --- |
   | `OPENAI_API_KEY` | an OpenAI API key; without it the model step is off |
   | `FULLA_CATEGORIZER_MODEL` | the chat model to ask (default: Fulla's fine-tuned transaction model id in `src/lib/categorizer.ts`) |

   With a key set, the lines no rule or known merchant recognised are sent,
   one per request at temperature 0.1, from `/api/categorize` (signed-in
   people only) to that model: the date, the statement text, the amount and
   the account's name, nothing else. Any failure (no credit, a rate limit, a
   timeout) leaves those lines in Other, as if the key were not set.
   Both values are public by design: what a signed-in person can do is decided by
   row-level security and the `fulla_*` functions, not by the key. Never put the
   service-role (secret) key in the web app.

On an iPhone, open the address in Safari and use Share → Add to Home Screen.
