# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Run via Docker (production-equivalent, hot-reload **not** included — image is rebuilt each time):

```bash
docker compose up -d --build   # build + start, exposed on http://localhost:3001
docker compose down            # stop
docker compose logs -f meeting-app
```

Run locally without Docker (faster iteration loop):

```bash
npm install
node server.js                 # listens on http://localhost:3000
```

There is **no test suite, no linter, and no build step** — `node server.js` is the entire toolchain. The frontend is plain HTML/CSS/JS served statically; editing files in `public/` only requires a browser refresh (no bundler).

When changing the host port, only edit the **left** side of the mapping in `docker-compose.yml`; the container always listens on `3000` (env `PORT`). The container stores meeting JSON in `/app/data`, mounted from `./data` on the host.

## Architecture

Single-process Node app: **Express** serves static assets + a tiny REST surface, **Socket.io** carries all live collaboration. There is no database, no ORM, no client framework — this minimalism is intentional (see README "Stack technique").

### Persistence model — important to understand before editing `server.js`

One meeting = one JSON file at `DATA_DIR/<id>.json`. The pattern in `server.js`:

1. **In-memory cache** (`cache: Map<id, meetingData>`) is the source of truth during the process lifetime. Every mutation handler does `loadMeeting(id)` (which hits the cache first, falls back to disk), mutates the returned object **in place**, then calls `saveMeeting(id)`.
2. **Write serialization** (`writeQueues: Map<id, Promise>`) chains writes per-meeting so concurrent socket events on the same meeting don't race on `fs.writeFile`. Preserve this when adding new mutation events — never write to disk directly.
3. The cache is never evicted. Acceptable for the "few thousand meetings" scale called out in the README; if that changes, an LRU is the right place to start.

### Real-time event flow

- Client connects → emits `join { meetingId, name }` → server adds socket to a Socket.io **room named after `meetingId`** and replies with `state` (full meeting snapshot).
- All subsequent mutations are scoped to that room. Pattern across handlers: validate `meetingId === joinedMeeting` (closure-captured per-socket), mutate, persist, broadcast.
- **Notes** use `socket.to(room).emit(...)` (excludes sender, since the sender already has the text locally). **Everything else** uses `io.to(room).emit(...)` (includes sender, so the server's clamped/sanitized version is the canonical one shown).
- Participants list lives only in memory (`participants: Map<meetingId, Map<socketId, {name}>>`) — it's connection state, not persisted.

### Frontend conventions (`public/meeting.html`)

- All interactive logic is inline in `meeting.html` — no modules, no build. Two parallel arrays (`topicsState`, `pollsState`) mirror server state and are re-rendered wholesale on every event.
- **Debounces matter**: notes 250ms, title 400ms. These are the consensus model — "last write wins" with the debounce as the only contention-reduction mechanism. A real CRDT would be a significant rewrite; don't half-port one.
- `voterId` is a random string in `localStorage` used as the poll vote key. It deduplicates votes per device, not per user — losing localStorage = able to vote again. This is by design for the ephemeral-meetings use case.
- Server-side input clamping (`clamp(s, n)` in `server.js`) is the only length validation — frontend `maxlength` attributes are advisory.

### Things to know before changing the wire protocol

Event names are duplicated as string literals on both sides (e.g. `'topic:update'`). There's no shared schema file. When adding/renaming an event, grep both `server.js` and `public/meeting.html`.
