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
4. **Notes are a Yjs Y.Doc**, not a string. The cached meeting object holds a live `ydoc` (in-memory `Y.Doc`); on disk the field is `ydocState` (base64 of `Y.encodeStateAsUpdate(ydoc)`). Saves are debounced 800ms via `saveTimers` to avoid writing on every keystroke. Old meetings with a plaintext `notes` field auto-migrate on first `loadMeeting` (the string is inserted into the Y.Text and the field is dropped).

### Real-time event flow

- Client connects → emits `join { meetingId, name }` → server adds socket to a Socket.io **room named after `meetingId`** and replies with `state` (full meeting snapshot).
- All subsequent mutations are scoped to that room. Pattern across handlers: validate `meetingId === joinedMeeting` (closure-captured per-socket), mutate, persist, broadcast.
- **Notes** use `socket.to(room).emit(...)` (excludes sender, since the sender already has the text locally). **Everything else** uses `io.to(room).emit(...)` (includes sender, so the server's clamped/sanitized version is the canonical one shown).
- Participants list lives only in memory (`participants: Map<meetingId, Map<socketId, {name}>>`) — it's connection state, not persisted.

### Frontend conventions (`public/meeting.html`)

- The main script is `<script type="module">` — Yjs and `y-protocols/awareness` are imported from esm.sh. Other dependencies (socket.io, marked, DOMPurify) load as classic globals via `<script src>` *before* the module (so they're available when the deferred module runs).
- Two parallel arrays (`topicsState`, `pollsState`) mirror server state and are re-rendered wholesale on every event.
- **Notes are CRDT-backed via Yjs**:
  - Local input is diffed against `prevNotesValue` (longest common prefix + suffix) and translated into `ytext.insert` / `ytext.delete` ops inside a `'local'` transaction.
  - Remote `ytext.observe` events skip if `transaction.origin === 'local'`. Otherwise they replace `notes.value` and restore the local cursor via Yjs `RelativePosition` (captured on every selection event into `lastAnchor` / `lastHead`) — this is what makes the cursor not jump when others type.
  - Local cursors are broadcast through `awareness.setLocalStateField('cursor', { anchor, head })` (the relative positions are encoded with `Y.encodeRelativePosition` and packed as `Array.from(uint8)` so the awareness JSON state stays serializable).
  - Remote cursors are rendered in `#notesCursors` (an `inset:0`, `pointer-events:none` overlay). Pixel coords come from a singleton mirror-`<div>` with the same fonts/padding/borders as the textarea — see `getCaretCoordinates`. The mirror's `span.offsetTop` needs `+ borderTopWidth` because `offsetTop` is measured from the parent's padding edge, not its outer border.
- **Title** still uses a 400ms debounced `meeting:title` socket event (not Yjs — short field, no concurrent-edit pain).
- `voterId` is a random string in `localStorage` used as the poll vote key. It deduplicates votes per device, not per user — losing localStorage = able to vote again. This is by design for the ephemeral-meetings use case.
- Server-side input clamping (`clamp(s, n)` in `server.js`) is the only length validation — frontend `maxlength` attributes are advisory. Notes have no clamp (they're a Y.Text — clamping would corrupt the CRDT).

### Things to know before changing the wire protocol

Event names are duplicated as string literals on both sides (e.g. `'topic:update'`). There's no shared schema file. When adding/renaming an event, grep both `server.js` and `public/meeting.html`.

The Yjs events (`yjs:sync`, `yjs:update`, `yjs:awareness`) carry binary `Uint8Array` payloads — Socket.io serializes these natively. On the server use `toUint8(data)` to coerce whatever Socket.io hands back (Buffer or ArrayBuffer) into a `Uint8Array` before passing to Yjs.
