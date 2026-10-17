# Privacy

## What Fulla stores, and where

| Where | What |
|---|---|
| Your phone | A full copy of your household: transactions, structure, members' display names. Your Supabase URL, anon key and session, encrypted with a key held by Android's keystore. |
| Your Supabase project (shared households only) | The same household data, and the email addresses of the household's accounts (in Supabase Auth). |
| Anywhere else | Nothing. |

Fulla has no server. Its authors never receive your data, your email address,
or any signal that you use the app.

## What Fulla does not do

- No analytics, telemetry or usage statistics.
- No crash reporting to anyone.
- No advertising.
- No connection to any host other than your own Supabase project and,
  for checking and installing updates, GitHub's.
- No automatic cloud backup of its data through Android's backup service.

## Checking for updates

Fulla is distributed only as signed APKs on GitHub Releases, never through
Google Play, so it checks for its own updates: it asks
`api.github.com` whether a newer release exists, and, if you choose to
install one, downloads the APK from `github.com` or one of GitHub's
`*.githubusercontent.com` asset hosts. No household data is part of either
request. This is on by default and can be turned off in Settings › About.

## Signing up without an email confirmation

Setting up a shared household, whether through the app or by hand
([self-hosting.md](self-hosting.md)), turns off Supabase's "Confirm email"
step (`mailer_autoconfirm`), so an account is usable as soon as it is
created. That is so a household does not need its own mail server just to
sign in: Supabase's built-in email only reaches addresses on the project
owner's own Supabase team, so with confirmation on, nobody else in the
household could ever confirm their account.

This is not an open door to your data. Signing up gives an account nothing
by itself — a household is reachable only through an invite, and an account
with no invite sees no household at all. Once everyone who needs access has
joined, the project owner can turn off **Allow new users to sign up**
(**Authentication → Sign In / Providers**) to close sign-up entirely; it is
optional, since an uninvited account was never a leak, but it is tidier.

## Inside a household

Everyone in a household sees all of its transactions. There are no private
entries. Roles limit who can change the household's structure and membership,
not who can read.

A member who is removed loses access immediately. What they entered stays, as
part of the household's history.

## Checking it yourself

The database side is in this repository: `supabase/migrations/` is everything
that runs in your project, and `npm run test:db` includes tests that a
stranger, and an anonymous request, can reach nothing.

The network side can be checked with an intercepting proxy such as
[mitmproxy](https://mitmproxy.org): point the phone at it, install its
certificate, use the app for a while, and look at the list of hosts. You
should see only `<your-project>.supabase.co`, plus `api.supabase.com` during
the few minutes of setting a project up from the app, if you chose to, and
`api.github.com`, `github.com` or a `*.githubusercontent.com` host when
checking for or installing an update. Anything else is a bug; please report it.

## Permissions

- **Internet**: to reach your own Supabase project.
- **Camera**: only to scan an invite's QR code, only when you tap "Scan an
  invite". The picture is decoded on the phone and never stored or sent.
- **Biometrics**: only if you turn on the app lock.

## The web app's optional categorizer

The web app (`web/`) can ask a language model to categorise imported lines
that no household rule and no known merchant recognised. It is off unless
whoever deploys the web app sets `OPENAI_API_KEY` on the server. When it is
on, those lines' date, statement text, amount and account name go from the
web app's server to OpenAI; nothing else about the household does, and the
key never reaches the browser. Rules and the known-merchants list run in the
browser and send nothing anywhere.
