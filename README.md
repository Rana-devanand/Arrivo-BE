# Arrivo backend

Node + TypeScript + Express API between the Flutter app and Supabase.

```
Flutter app ──(Supabase Auth: sign in)──> Supabase
     │
     └──(Bearer token)──> this API ──(service role)──> Supabase Postgres
```

The app signs in with Supabase and sends the access token to this API. The API
checks the token, then reads and writes the database. Every query is scoped to
the signed-in user, and row level security in the migration is a second layer.

## Quick start (no Supabase needed)

```bash
cd backend
cp .env.example .env        # DB_DRIVER=memory by default
npm install
npm run dev                 # http://localhost:4000
npm test
```

In memory mode data is lost on restart, and the token `dev:<name>` signs you in
(the app sends `dev:alex` in debug builds when no Supabase is configured).

## Connect your Supabase project

> **Use a NEW Supabase project for Arrivo.** Do not point this at another app's
> production database.

1. Create the project in the Supabase dashboard.
2. Open **SQL Editor**, paste the whole of
   `supabase/migrations/20261021000001_arrivo_core.sql` and run it. It only
   creates new objects (it never drops or alters existing ones).
3. Create `backend/.env` (it is gitignored) and fill in:

   ```
   DB_DRIVER=supabase
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service role / secret key>
   ```

   The service role key bypasses row level security. It stays on the server.
   Never put it in the app or in git.
4. `npm run dev`. `GET /health` should report `"db":"supabase"`.

### Sign-in providers

In **Authentication > Providers** enable Google and Apple (each needs its own
client id and secret from Google Cloud / Apple Developer). Under
**Authentication > URL Configuration > Redirect URLs** add:

```
com.arrivo.arrivo://login-callback/
```

For quick testing you can use the app's developer email sign-in (debug builds
only), which needs only the **Email** provider (turn off "Confirm email" while
developing).

## Run the app against this API

```bash
# Android emulator (reaches your PC at 10.0.2.2)
flutter run --dart-define=USE_BACKEND=true

# Real phone on the same Wi-Fi: use your PC's LAN address
flutter run -d <device> --dart-define=USE_BACKEND=true \
  --dart-define=API_BASE_URL=http://<PC-LAN-IP>:4000

# With Supabase sign-in
flutter run -d <device> --dart-define=USE_BACKEND=true \
  --dart-define=API_BASE_URL=http://<PC-LAN-IP>:4000 \
  --dart-define=SUPABASE_URL=https://<project-ref>.supabase.co \
  --dart-define=SUPABASE_PUBLISHABLE_KEY=<publishable or anon key>
```

On a real phone, Windows Firewall may ask to allow Node on port 4000. Allow it
on private networks.

## How invitations work

1. Alex adds a contact. The API returns an invite code like `ABCD-2345`, and the
   app shows it with Share and Copy.
2. The invited person installs Arrivo, signs in, opens **Contacts > Got an invite
   code?** and enters it. They see who invited them, then accept or decline.
3. Accepting links their account to the contact, so the contact becomes
   *Accepted*. Only accepted contacts can be chosen for a journey.
4. When Alex starts a journey and picks them, it appears under **Following now**
   on their Home screen (`GET /following`), until the journey ends.

Codes are rate limited, never reveal who owns them until you are signed in, and
cannot be used by two different people.

## Migrations

Run them in order with `supabase db push` (from `backend/`):

- `20261021000001_arrivo_core.sql`: tables, indexes, row level security.
- `20261021000002_contact_invites.sql`: invite code columns on `contacts`.
- `20261021000003_saved_places.sql`: saved places table with row level security.
- `20261021000006_track_token.sql`: private track token per journey (for the background service).
- `20261021000005_notifications_recent_places.sql`: in-app notifications and recently picked places.
- `20261021000004_route_and_plate.sql`: train and metro modes; planned route, origin and number plate photo on journeys.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` refuses the memory DB and dev routes |
| `PORT` | `4000` | |
| `DB_DRIVER` | `memory` | `supabase` for the real database |
| `SUPABASE_URL` | | required for `supabase` |
| `SUPABASE_SERVICE_ROLE_KEY` | | required for `supabase`, server only |
| `CORS_ORIGINS` | empty | browser origins only; mobile apps ignore it |
| `ENABLE_OVERDUE_JOB` | `false` | marks journeys overdue after the grace period |
| `ENABLE_DEV_ROUTES` | `false` | dev-only "accept contact" route; rejected in production |
| `WATCH_BASE_URL` | `https://arrivo.app/w` | base of public watch links |
| `GOOGLE_PLACES_API_KEY` | | enables place search (Places API New + Geocoding). Empty = search answers 503, saved places still work |
| `GOOGLE_ROUTES_API_KEY` | falls back to `GOOGLE_PLACES_API_KEY` | Routes API key for distance, time and the path on the map. Without it, trips are straight-line estimates |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | | enables profile photos. The server signs each upload, the phone uploads straight to Cloudinary |
| `RESEND_API_KEY` | | enables invitation emails (Resend). Empty = no email, code sharing only |
| `FIREBASE_SERVICE_ACCOUNT` | | enables push notifications (Firebase Cloud Messaging). The service account key as JSON or base64. Empty = in-app notifications only. Phones register with `POST /v1/devices` and leave with `DELETE /v1/devices` |
| `SITE_URL` | | the Arrivo website. Checkout returns here (`/pricing/success`, `/pricing/cancelled`) and it is allowed by CORS |
| `DODO_API_KEY` / `DODO_MODE` / `DODO_WEBHOOK_SECRET` | `test` | Dodo Payments. Mode is `test` or `live` (production refuses `test`). The webhook is `POST /v1/billing/webhook`. Empty = Plus cannot be bought |
| `DODO_PRODUCT_PLUS_MONTHLY` / `_6_MONTHS` / `_YEARLY` | | the Dodo product id of each Arrivo Plus plan |
| `MAIL_FROM` | `Arrivo <invites@tryarrivo.com>` | sender; the domain must be verified in Resend |

## Logs: did the notification go out?

Search the log for `[push]` and `[progress]`. Lines never contain tokens, coordinates, place names or emails, only ids, counts and Firebase error codes. On Vercel: Project > Logs (or `vercel logs <deployment-url>`).

| Line | Meaning |
|---|---|
| `[push] on: ...` / `[push] off: FIREBASE_SERVICE_ACCOUNT is not set` | Start-up. If it says off, no push is ever sent. |
| `[push] fcm type=journey_progress sent=1 failed=0` | Firebase accepted it for 1 phone. |
| `[push] fcm type=... sent=0 failed=1 errors=messaging/registration-token-not-registered x1` | Firebase refused. The error code says why; dead devices are removed. |
| `[push] skip type=... reason=no_devices` | The contact has no registered phone (they have not opened the app and allowed notifications). |
| `[push] failed type=... reason=<code>` | Could not call Firebase at all (bad or missing key, network). |
| `[progress] update sent journey=<id> every=15min contacts=2 place=local` | A progress update was sent. `place` is `local` (road and area), `regional` (city and state) or `none` (no place named). |
| `[progress] place lookup failed, sending without a place: ...` | The Geocoding call failed; the update still went, without a place. |

"sent" means Firebase accepted the message, not that the phone showed it.

## API

All routes are under `/v1` and need `Authorization: Bearer <token>`, except
`/health` and `GET /v1/watch/:token`.

| Method | Path | What it does |
|---|---|---|
| GET / PUT | `/me` | read / update your profile (name, phone, photo address). Includes your sign-in email |
| POST | `/me/avatar/ticket` | signed, one-user permit to upload a profile photo to Cloudinary |
| DELETE | `/me` | request account deletion (ends a journey in progress first) |
| POST | `/devices` | save a push token |
| GET / POST | `/contacts` | list / invite a contact (phone or email). Returns an 8-character `inviteCode` |
| DELETE | `/contacts/:id` | remove a contact (loses access immediately) |
| POST | `/contacts/:id/resend` | the invite code again, to share once more |
| GET | `/invitations/pending` | invitations sent to the email you signed in with (verified emails only), so no code is needed |
| GET | `/invitations/:code` | the invited person previews who invited them |
| POST | `/invitations/:code/accept`, `/decline` | the invited person answers; accepting links their account |
| GET | `/places/search?q=&lat=&lng=&lang=&session=` | place suggestions (India first, villages included) |
| GET | `/places/details?placeId=` | coordinates and address of a suggestion |
| GET | `/places/reverse?lat=&lng=` | address for a pin or current location |
| GET / POST | `/places/saved` | list / save a place (Home, Work, other; max 30) |
| DELETE | `/places/saved/:id` | remove a saved place |
| GET | `/routes/plan?oLat&oLng&dLat&dLng&mode=[&boardLat&boardLng&boardName&alightLat&alightLng&alightName&access&egress]` | distance, time, path and legs (walk to station, train/metro, walk) for walk, bike, car, train or metro. Falls back to an estimate (`estimated: true`) |
| POST | `/journeys/photo-ticket` | signed permit to upload a number plate photo to Cloudinary |
| GET | `/notifications` | invitations waiting for you plus stored events (accepted invite, journey started/arrived/cancelled/late, shared ride photo, SOS); also returns `unread` |
| GET | `/notifications/unread-count` | number of unread items (for the bell badge) |
| POST | `/notifications/read` | mark some (or all) read |
| GET / POST / DELETE | `/places/recent` | places the person picked before (so search can skip the paid lookup) |
| GET | `/routes/stations?lat&lng&mode=train|metro` | nearest railway / metro stations to a place (Google Places), closest first |
| POST | `/track/:token/location` | public: the phone's background service sends location with the journey's private track token (no sign-in). 410 once the journey ends |
| GET | `/trusting` | people whose trusted contact I am |
| GET | `/following` | journeys in progress that others shared with you |
| POST | `/journeys` | start a journey (accepted contacts only, one at a time) |
| GET | `/journeys`, `/journeys/active`, `/journeys/:id` | history, current, one |
| PATCH | `/journeys/:id` | change the arrival time (also clears "overdue") |
| POST | `/journeys/:id/complete`, `/cancel` | end a journey (idempotent) |
| POST | `/journeys/:id/location` | upload up to 100 location points |
| POST / DELETE | `/journeys/:id/watch-link` | create / revoke a watch link |
| GET | `/watch/:token` | public, read-only view for people without the app |
| GET / POST / DELETE | `/safety/timer` | safety timer ("I am safe" cancels) |
| POST | `/safety/sos` | record an SOS |

Errors look like `{ "error": { "code", "message", "details?" } }`.

## Security notes

- Tokens are verified with Supabase on every request (cached for 30 seconds).
- Ownership is enforced in code (`owner_id = user`) and by row level security.
- Only **accepted** contacts can follow a journey. Removing a contact revokes
  access to journeys in progress.
- Request bodies, query strings, tokens and coordinates are never logged.
- The watch link shows the first name, status, destination and last location
  only while the journey is in progress; it is closed when the journey ends.
- `helmet`, a request size limit and rate limits are on (stricter on `/watch`).

## Not built yet

- Push notifications to the phone (FCM/APNs). Events are saved and shown in the in-app Notifications screen, which the app checks every 15 seconds. Overdue alerts are not yet written as notifications.
- Sending invitations by SMS (email works once RESEND_API_KEY is set). The app also shows the invite code to share by hand.
- The app uploading live location (the endpoint is ready; needs the phone's
  background location code).
- Subscriptions and billing.

## Deploy on Vercel

The repo includes `vercel.json` and `api/index.js`. Vercel runs the API as one serverless function (no port, no timers).

1. Import the `backend` folder as the project root. Build command `npm run build` (already in vercel.json).
2. In Project Settings > Environment Variables set: `NODE_ENV=production`, `DB_DRIVER=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WATCH_BASE_URL`, and the optional keys (`GOOGLE_PLACES_API_KEY`, `RESEND_API_KEY`, `CLOUDINARY_*`). If any required one is missing the function fails at start (500 FUNCTION_INVOCATION_FAILED); the Vercel logs name the missing setting.
3. Check `https://<project>.vercel.app/health`.
4. Overdue journeys: Vercel has no timer, so set `CRON_SECRET` (16+ characters) and call `GET /v1/internal/overdue` every minute with `Authorization: Bearer <CRON_SECRET>` (Vercel Cron on a paid plan, or any pinger).

Serverless limits to know: a function can run for at most the plan limit, rate limiting is per instance, and the first request after a quiet period is slower (cold start).
