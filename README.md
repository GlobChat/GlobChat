# 🌍 Global Chat

A polished, temporary global live-chat room built with:

- HTML5
- CSS3
- Vanilla JavaScript
- Supabase JavaScript client
- Supabase Realtime Broadcast

## Architecture

```text
Browser A ─────┐
Browser B ─────┼──> Supabase Realtime Broadcast ──> currently connected browsers
Browser C ─────┘

No application users table
No application messages table
No chat-history query
No permanent display-name storage
```

The browser keeps the current display name only in JavaScript memory. Messages are rendered in the current page only. Refreshing or reopening starts with an empty message area.

## 1. Create a Supabase project

Open the Supabase dashboard and create a project.

You do NOT need to create a `users` table or a `messages` table for this application.

## 2. Enable public Realtime channels

In your Supabase dashboard:

1. Open your project.
2. Go to **Realtime** settings.
3. Make sure the **Realtime service** is enabled.
4. Under **Channel Restrictions**, allow **public channels**.

This application intentionally uses a public channel because users do not create accounts or sign in.

## 3. Get the project URL and frontend key

In the Supabase dashboard, open the project's **Connect** dialog.

Copy:

- Project URL
- Publishable key (`sb_publishable_...`) if your project exposes the new key format.

If your project still exposes the legacy frontend `anon` key, that can be used as the browser key as well.

Never use:

- `service_role`
- `sb_secret_...`
- any server/admin key

in `config.js`.

## Keys & security

All frontend credentials live in **`config.js`** (nothing in `script.js`):

- The URL and publishable/anon key are **public by design**. They ship to every browser, appear in every request, and are readable by any visitor. This is normal for a static app and is not a leak.
- What must never be committed or shipped: `service_role` / `sb_secret_...` keys. As of this writing none exist anywhere in this repository's history.
- `config.js` validates its own key at load time and refuses to run if a non-anon JWT role is pasted in by mistake.

The actual security boundary is on the Supabase side — verify these once per project:

1. **RLS enabled** on every table the anon role can touch (e.g., `message_reports`: insert-only policy, no select/update/delete for `anon`).
2. **Storage policies** on `chat-attachments`: public read only if you accept public file URLs; write restricted to `anon` with size/type constraints as needed.
3. **Realtime**: keep channel restrictions as tight as your product allows; this app intentionally uses public channels because there are no accounts.

Rotating keys: Dashboard → Settings → API → rotate, then update `config.js`. Because it is the only place credentials appear, rotation is a one-file change.

## 4. Configure config.js

Open `config.js` and replace the placeholders with your actual project URL
and frontend publishable/anon key:

```js
const SUPABASE_URL = "https://your-project-ref.supabase.co";
const SUPABASE_KEY = "sb_publishable_xxxxxxxxxxxxxxxxx";
```

Do not commit a secret/service-role key — `config.js` will refuse to run if
it detects one.

## 5. Run locally

Because this is a static site, you can use any static server.

For example, with VS Code Live Server:

1. Open the project folder.
2. Start Live Server.
3. Open the local URL.
4. Open the same URL in a second browser/device.
5. Enter different display names.
6. Send messages.

Both connected browsers should receive new messages immediately.

## 6. Deploy

The project can be deployed to:

- GitHub Pages
- Vercel
- Netlify
- Any static web host

Upload:

```text
index.html
style.css
script.js
README.md
```

No backend server is required.

## Message-history behavior

There is deliberately no code that:

- inserts messages into Postgres
- queries message history
- stores names in a users table
- stores chat messages in localStorage
- stores chat messages in sessionStorage

When a new browser joins, it only subscribes to future Broadcast events. It does not request old messages.

Refreshing the page destroys the in-memory message list.

## Online count

The online count uses Supabase Realtime Presence only to maintain an approximate count of currently connected browser sessions.

Presence contains only a random client ID and timestamp. The display name is NOT put into presence state.

If you want the strictest possible Broadcast-only implementation, remove the Presence handlers and the online-count UI. Chat delivery itself still uses Broadcast.

## Basic protection included

- Display-name length limit: 32 characters
- No enforced message length limit (a large technical backstop exists purely so a broadcast frame can't blow past Realtime's payload size)
- File attachments capped at 50 MB — uploaded to a Supabase Storage bucket (`chat-attachments`); only the resulting public URL travels in the broadcast message. Requires the bucket + policies from `supabase-storage-setup.sql` to exist on the project, and (unlike the rest of this app) uploaded files are **not** ephemeral until a cleanup job is set up — see `supabase-cleanup-cron.sql` for an optional 24h auto-delete schedule
- Empty-name prevention
- Empty-message prevention (unless a file is attached)
- Control-character filtering
- Client-side send rate limit
- User content rendered with `textContent`, not `innerHTML`
- No admin/service-role key in frontend code
- Reconnect attempts after Realtime errors
- Connection status indicator
- Mobile-friendly layout

## Private chat rooms (4-digit code, end-to-end encrypted)

The Private Chat tab lets people spin up temporary rooms without accounts:

1. **Create a chat** — you get a random 4-digit code (shown in the room header; tap it to copy).
2. **Share the code** with whoever should join — via any channel you like.
3. **Join a chat** — the other person enters the code and lands in the same room.

How it works:

- The room's Realtime channel name is derived from the code (`private-chat:room-<CODE>`).
- The AES-GCM-256 room key is derived from the code with **PBKDF2 (SHA-256, 150,000 iterations)** over a per-room random salt. Every frame carries `{salt, ciphertext}`; the plaintext envelope (sender name, message text, timestamp, sender session id) exists only inside the ciphertext.
- Sender identity for "own message" styling is taken from the authenticated envelope, so two people sharing a display name are never confused.
- Frames that fail AES-GCM authentication (wrong code / tampering) are dropped silently.
- Duplicate frame IDs are deduplicated; oversized frames are rejected before decryption work.
- Rooms are capped at 8 per session; a shared rate limiter applies to global + room sends.
- Per-room presence shows how many people are currently in the room.
- Unread badges appear on the Private tab and in the sidebar when messages arrive while you're elsewhere.
- Everything is in-memory: leaving the chat or refreshing wipes rooms, keys, and transcripts. Joining mid-conversation shows only future messages.

### Honest threat model for private rooms

- Message **content** is end-to-end encrypted; a passive listener on the Realtime channel sees only salts and ciphertext.
- A 4-digit code has only 10,000 combinations. PBKDF2 makes offline brute force expensive per room but not impossible for a well-resourced attacker who records frames. Treat private rooms as strong casual privacy, not state-of-the-art secrecy.
- Room metadata (channel name, timing, approximate size) is inherently visible to anyone who connects to the same channel.
- Like everything else here, client-side controls are usability protections, not server-enforced security.

### Important security note

Client-side validation and rate limiting can be bypassed by a malicious client. They are mainly usability protections.

Because this room is public and unauthenticated, a determined attacker can still connect directly to Realtime and send abusive traffic. If this becomes a public production service, add server-side abuse controls, authentication, or a trusted relay/API layer.

## Important privacy note

Supabase Realtime itself is a service handling the live transport. This project does not create a persistent application chat-history table.

Do not enable or add any custom database persistence for chat messages if your goal is strictly temporary chat.

## Session persistence (soft reload)

State lives in `sessionStorage` and survives an **F5 / soft reload**: your name, private rooms, keys and transcripts are all restored and the channels re-subscribe automatically. It is destroyed when the **tab or browser closes** — the app's privacy contract is unchanged.

A **hard refresh (Ctrl+Shift+R)** intentionally wipes the session: the boot path inspects the NavigationTiming entry and treats a cache-bypassed full download as a fresh start.

Hosting requirement: serve `index.html` with `Cache-Control: no-cache` (or `max-age=0, must-revalidate`). Netlify/Vercel: add a headers rule. GitHub Pages does not allow custom headers — there, a soft refresh within its 10-minute cache window may be classified as a hard refresh (chat resets). All other hosts work out of the box.

## Restricted networks (FortiGate / FortiGuard, hotel & office WiFi)

The realtime client is tuned for networks that silently kill long-lived connections:

- **Heartbeat every 10s** (default 30s) — dead sockets are detected ~3× faster, and the periodic traffic keeps NAT/DPI session entries alive.
- **Reconnect backoff capped at 5s** (default grows to 10–30s) — the classic "reconnects after a 20–30s loop" becomes a ≤5s loop.
- **Independent 5s watchdog** — verifies actual socket truth and forces a reconnect even when the library's own detection misses a silent drop (typical DPI behaviour).
- **Immediate reconnect** on network-online and on tab re-focus.
- **supabase-js is vendored** (`vendor/supabase.min.js`) and **fonts load non-blocking** — a filtered CDN or font request can no longer stall page load.

FortiGate-side recommendations (ask your admin):

1. Exempt `*.supabase.co` from SSL Deep Inspection (DPI is the most common killer of long-lived WSS sessions), or at minimum allow WSS to it on port 443.
2. Allow the `cdn.jsdelivr.net` / app-hosting categories in the web filter profile.
3. Keep firewall session TTL for established TCP/443 sessions at the default (3600s) or higher; the 10s heartbeat keeps entries refreshed either way.

## Files

- `index.html` — UI structure and Supabase import
- `config.js` — the only file containing frontend credentials (public-by-design publishable/anon key)
- `vendor/supabase.min.js` — vendored supabase-js build (no CDN dependency at load time)
- `style.css` — responsive glassmorphism dark UI
- `script.js` — Realtime Broadcast, Presence count, validation, reconnect logic, private rooms (create/join by 4-digit code, PBKDF2 + AES-GCM end-to-end encryption)
- `README.md` — setup and deployment instructions
- `tests/` — baseline test suite (`node tests/run-baseline.js`) and a live-backend smoke test (`node tests/smoke-live.js`); requires `npm install puppeteer-core` and a local Chrome/Chromium binary
# GlobChat
# GlobChat
