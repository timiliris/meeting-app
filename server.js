// ---------------------------------------------------------------------------
// Meeting App - serveur principal
// Express + Socket.io + persistance JSON (1 fichier par réunion)
// Notes : CRDT Yjs (édition concurrente avec curseurs multiples).
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const Y = require('yjs');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// --- Couche de persistance ------------------------------------------------
// Une réunion = un fichier JSON dans DATA_DIR/<id>.json
// Les notes sont un Y.Doc en mémoire (CRDT) sérialisé en base64.
const cache = new Map();
const writeQueues = new Map();    // sérialise les écritures par fichier
const saveTimers = new Map();     // debounce des sauvegardes Yjs

function fileFor(id) {
  return path.join(DATA_DIR, `${id}.json`);
}

function loadMeeting(id) {
  if (cache.has(id)) return cache.get(id);
  const f = fileFor(id);
  if (!fs.existsSync(f)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!data.locks) data.locks = { notes: false, topics: false, polls: false, title: false };
    if (!data.hostToken) data.hostToken = null;

    // Notes : initialisation du Y.Doc
    data.ydoc = new Y.Doc();
    if (data.ydocState) {
      try {
        Y.applyUpdate(data.ydoc, Buffer.from(data.ydocState, 'base64'));
      } catch (e) {
        console.error(`[load] échec décodage Yjs ${id}:`, e.message);
      }
    } else if (typeof data.notes === 'string' && data.notes.length > 0) {
      // Migration : ancien format texte → Y.Text
      data.ydoc.getText('notes').insert(0, data.notes);
    }
    delete data.notes; // on lit toujours via ydoc à partir de maintenant

    // Sauvegarde debouncée à chaque mise à jour
    data.ydoc.on('update', () => scheduleSave(id));

    cache.set(id, data);
    return data;
  } catch (e) {
    console.error(`[load] échec lecture ${id}:`, e.message);
    return null;
  }
}

function scheduleSave(id) {
  if (saveTimers.has(id)) return;
  saveTimers.set(id, setTimeout(() => {
    saveTimers.delete(id);
    saveMeeting(id);
  }, 800));
}

async function saveMeeting(id) {
  const data = cache.get(id);
  if (!data) return;
  // Sérialiser le Y.Doc en base64 ; ne pas écrire l'objet ydoc directement
  const toSave = { ...data };
  if (data.ydoc) {
    toSave.ydocState = Buffer.from(Y.encodeStateAsUpdate(data.ydoc)).toString('base64');
  }
  delete toSave.ydoc;

  const prev = writeQueues.get(id) || Promise.resolve();
  const next = prev.then(() =>
    fs.promises.writeFile(fileFor(id), JSON.stringify(toSave, null, 2), 'utf8')
      .catch(e => console.error(`[save] échec écriture ${id}:`, e.message))
  );
  writeQueues.set(id, next);
  return next;
}

function createMeeting(title) {
  const id = nanoid(10);
  const ydoc = new Y.Doc();
  const data = {
    id,
    title: title || 'Nouvelle réunion',
    topics: [],
    polls: [],
    hostToken: nanoid(24),
    locks: { notes: false, topics: false, polls: false, title: false },
    createdAt: Date.now(),
    nextTopicId: 1,
    ydoc,
  };
  ydoc.on('update', () => scheduleSave(id));
  cache.set(id, data);
  saveMeeting(id);
  return data;
}

// État public renvoyé aux clients : pas de hostToken, pas d'objet ydoc.
// `notes` est un snapshot textuel pour les clients hors-Yjs / l'API REST.
function publicState(m) {
  if (!m) return null;
  const { hostToken, ydoc, ...rest } = m;
  rest.notes = ydoc ? ydoc.getText('notes').toString() : '';
  return rest;
}

// --- Express ---------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/meetings', (req, res) => {
  const title = (req.body && req.body.title) || 'Nouvelle réunion';
  const m = createMeeting(title);
  res.json({ id: m.id, url: `/m/${m.id}`, hostToken: m.hostToken });
});

app.get('/api/meetings/:id', (req, res) => {
  const m = loadMeeting(req.params.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  res.json(publicState(m));
});

app.get('/m/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'meeting.html'));
});

// --- Socket.io -------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 }); // 5 MB pour les updates Yjs

const participants = new Map(); // meetingId -> Map<socketId, { name, isHost }>

function emitParticipants(meetingId) {
  const room = participants.get(meetingId);
  const list = room
    ? Array.from(room.entries()).map(([socketId, p]) => ({
        socketId, name: p.name, isHost: !!p.isHost
      }))
    : [];
  io.to(meetingId).emit('participants', list);
}

function clamp(s, n) { return String(s == null ? '' : s).slice(0, n); }

// Convertit Buffer/ArrayBuffer reçu de Socket.io en Uint8Array pour Yjs
function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

io.on('connection', (socket) => {
  let joinedMeeting = null;
  let pseudo = 'Anonyme';
  let isHost = false;

  function canWrite(m, area) {
    if (!m || !m.locks) return true;
    if (isHost) return true;
    return !m.locks[area];
  }

  socket.on('join', ({ meetingId, name, hostToken }) => {
    const m = loadMeeting(meetingId);
    if (!m) {
      socket.emit('error_msg', 'Réunion introuvable');
      return;
    }
    joinedMeeting = meetingId;
    pseudo = clamp(name || 'Anonyme', 40);
    isHost = !!(hostToken && m.hostToken && hostToken === m.hostToken);

    socket.join(meetingId);
    if (!participants.has(meetingId)) participants.set(meetingId, new Map());
    participants.get(meetingId).set(socket.id, { name: pseudo, isHost });

    socket.emit('state', publicState(m));
    socket.emit('role', { isHost, socketId: socket.id });
    // Snapshot Yjs complet pour le nouveau client
    socket.emit('yjs:sync', Y.encodeStateAsUpdate(m.ydoc));
    emitParticipants(meetingId);
  });

  // --- Notes (Yjs) — relai des updates entre clients + persistance ---
  socket.on('yjs:update', (update) => {
    if (!joinedMeeting) return;
    const m = loadMeeting(joinedMeeting);
    if (!m) return;
    if (!canWrite(m, 'notes')) return; // verrou : on ignore silencieusement
    try {
      const u = toUint8(update);
      Y.applyUpdate(m.ydoc, u, 'remote'); // déclenche scheduleSave via observer
      socket.to(joinedMeeting).emit('yjs:update', u);
    } catch (e) {
      console.error('[yjs:update]', e.message);
    }
  });

  // Awareness : positions de curseur, sélections, identité — relais pur
  socket.on('yjs:awareness', (update) => {
    if (!joinedMeeting) return;
    try {
      socket.to(joinedMeeting).emit('yjs:awareness', toUint8(update));
    } catch (e) {
      console.error('[yjs:awareness]', e.message);
    }
  });

  // --- Titre ---
  socket.on('meeting:title', ({ meetingId, title }) => {
    if (meetingId !== joinedMeeting) return;
    const m = loadMeeting(meetingId);
    if (!m) return;
    if (!canWrite(m, 'title')) return socket.emit('error_msg', 'Titre verrouillé par l\'animateur');
    m.title = clamp(title, 200);
    saveMeeting(meetingId);
    io.to(meetingId).emit('meeting:title', { title: m.title });
  });

  // --- Sujets / agenda ---
  socket.on('topic:add', ({ meetingId, title, description }) => {
    if (meetingId !== joinedMeeting) return;
    const m = loadMeeting(meetingId);
    if (!m) return;
    if (!canWrite(m, 'topics')) return socket.emit('error_msg', 'Agenda verrouillé par l\'animateur');
    const topic = {
      id: m.nextTopicId++,
      title: clamp(title || 'Sans titre', 200),
      description: clamp(description, 2000),
      done: 0,
    };
    m.topics.push(topic);
    saveMeeting(meetingId);
    io.to(meetingId).emit('topic:add', topic);
  });

  socket.on('topic:update', ({ meetingId, id, title, description, done }) => {
    if (meetingId !== joinedMeeting) return;
    const m = loadMeeting(meetingId);
    if (!m) return;
    if (!canWrite(m, 'topics')) return socket.emit('error_msg', 'Agenda verrouillé par l\'animateur');
    const topic = m.topics.find(t => t.id === id);
    if (!topic) return;
    if (title !== undefined) topic.title = clamp(title, 200);
    if (description !== undefined) topic.description = clamp(description, 2000);
    if (done !== undefined) topic.done = done ? 1 : 0;
    saveMeeting(meetingId);
    io.to(meetingId).emit('topic:update', topic);
  });

  socket.on('topic:delete', ({ meetingId, id }) => {
    if (meetingId !== joinedMeeting) return;
    const m = loadMeeting(meetingId);
    if (!m) return;
    if (!canWrite(m, 'topics')) return socket.emit('error_msg', 'Agenda verrouillé par l\'animateur');
    m.topics = m.topics.filter(t => t.id !== id);
    saveMeeting(meetingId);
    io.to(meetingId).emit('topic:delete', { id });
  });

  // --- Sondages ---
  socket.on('poll:create', ({ meetingId, question, options }) => {
    if (meetingId !== joinedMeeting) return;
    const m = loadMeeting(meetingId);
    if (!m) return;
    if (!canWrite(m, 'polls')) return socket.emit('error_msg', 'Scrutins verrouillés par l\'animateur');
    const cleanOpts = (Array.isArray(options) ? options : [])
      .map(o => clamp(o, 120))
      .filter(o => o.trim().length > 0)
      .slice(0, 10);
    if (!question || cleanOpts.length < 2) {
      socket.emit('error_msg', 'Un sondage doit avoir une question et au moins 2 options.');
      return;
    }
    const poll = {
      id: nanoid(8),
      question: clamp(question, 300),
      options: cleanOpts,
      votes: {},
    };
    m.polls.push(poll);
    saveMeeting(meetingId);
    io.to(meetingId).emit('poll:create', poll);
  });

  socket.on('poll:vote', ({ meetingId, pollId, optionIndex, voterId }) => {
    if (meetingId !== joinedMeeting) return;
    const m = loadMeeting(meetingId);
    if (!m) return;
    const poll = m.polls.find(p => p.id === pollId);
    if (!poll) return;
    const idx = Number(optionIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= poll.options.length) return;
    const vId = clamp(voterId || socket.id, 60);
    poll.votes[vId] = idx;
    saveMeeting(meetingId);
    io.to(meetingId).emit('poll:update', { id: pollId, votes: poll.votes });
  });

  socket.on('poll:delete', ({ meetingId, pollId }) => {
    if (meetingId !== joinedMeeting) return;
    const m = loadMeeting(meetingId);
    if (!m) return;
    if (!canWrite(m, 'polls')) return socket.emit('error_msg', 'Scrutins verrouillés par l\'animateur');
    m.polls = m.polls.filter(p => p.id !== pollId);
    saveMeeting(meetingId);
    io.to(meetingId).emit('poll:delete', { id: pollId });
  });

  // --- Présence : indicateurs "en train d'écrire" ---
  socket.on('typing:start', ({ meetingId, area }) => {
    if (meetingId !== joinedMeeting) return;
    socket.to(meetingId).emit('typing:start', { socketId: socket.id, name: pseudo, area: String(area || '') });
  });
  socket.on('typing:stop', ({ meetingId, area }) => {
    if (meetingId !== joinedMeeting) return;
    socket.to(meetingId).emit('typing:stop', { socketId: socket.id, area: String(area || '') });
  });

  // --- Permissions animateur ---
  socket.on('meeting:lock', ({ meetingId, area, locked }) => {
    if (meetingId !== joinedMeeting) return;
    if (!isHost) return socket.emit('error_msg', 'Action réservée à l\'animateur');
    const m = loadMeeting(meetingId);
    if (!m) return;
    if (!m.locks) m.locks = {};
    if (!['notes', 'topics', 'polls', 'title'].includes(area)) return;
    m.locks[area] = !!locked;
    saveMeeting(meetingId);
    io.to(meetingId).emit('locks:update', m.locks);
  });

  socket.on('participant:kick', ({ meetingId, targetSocketId }) => {
    if (meetingId !== joinedMeeting) return;
    if (!isHost) return socket.emit('error_msg', 'Action réservée à l\'animateur');
    if (targetSocketId === socket.id) return;
    const target = io.sockets.sockets.get(targetSocketId);
    if (target) {
      target.emit('kicked');
      target.disconnect(true);
    }
  });

  socket.on('disconnect', () => {
    if (joinedMeeting && participants.has(joinedMeeting)) {
      participants.get(joinedMeeting).delete(socket.id);
      socket.to(joinedMeeting).emit('typing:stop', { socketId: socket.id, area: '*' });
      // Notifier les autres pour qu'ils retirent le curseur de cette personne
      socket.to(joinedMeeting).emit('awareness:leave', { socketId: socket.id });
      emitParticipants(joinedMeeting);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[meeting-app] écoute sur http://localhost:${PORT}`);
  console.log(`[meeting-app] dossier données : ${DATA_DIR}`);
});
