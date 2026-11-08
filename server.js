'use strict';

/*
 * Cyber OSINT Lab — server di gioco
 * - Serve la SPA (public/index.html)
 * - Gestisce lobby e partite in tempo reale via WebSocket
 * - Le coordinate reali delle foto restano sul server fino alla rivelazione
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const ai = require('./ai');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 30;
const MAX_IMAGES = 30;
const MAX_ROUNDS = 30;
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;

// Distanza caratteristica del decadimento del punteggio (metri)
const SCALES = { city: 1000, region: 50000, world: 1500000 };

const INDEX = path.join(__dirname, 'public', 'index.html');

/* ------------------------------------------------------------------ HTTP */

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(INDEX, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('public/index.html non trovato');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

/* ------------------------------------------------------------ Geometria */

const R_EARTH = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const normLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;

function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

function score(distMeters, scaleMeters) {
  if (distMeters <= 20) return 5000;
  return Math.round(5000 * Math.exp(-(distMeters - 20) / scaleMeters));
}

/* -------------------------------------------------------------- IA reale */

// L'IA riceve SOLO l'immagine (già priva di metadati): mai coordinate o nome file.
function startAi(room, dataUrl) {
  const task = { status: 'thinking', searches: 0, result: null, error: null };
  room.ai = task;
  const stillCurrent = () => room.ai === task && rooms.get(room.code) === room;

  ai.geolocate(dataUrl, {
    tools: room.settings.aiTools,
    onStatus: (s) => {
      if (!stillCurrent()) return;
      task.status = 'searching';
      task.searches = s.count || 0;
      if (room.phase === 'round') broadcast(room);
    },
  })
    .then((r) => {
      task.status = 'done';
      task.result = r;
    })
    .catch((e) => {
      task.status = 'error';
      task.error = e.message;
      console.warn(`[stanza ${room.code}] IA: ${e.message}`);
    })
    .finally(() => {
      if (!stillCurrent()) return;
      if (room.phase === 'waiting_ai') reveal(room);
      else if (room.phase === 'round') broadcast(room);
    });
}

const aiBusy = (room) => !!room.ai && (room.ai.status === 'thinking' || room.ai.status === 'searching');

/* ---------------------------------------------------------------- Stanze */

const rooms = new Map();
let nextId = 1;

const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 });

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function sendError(ws, message, context) {
  send(ws, { t: 'error', message, context: context || null });
}

function cleanCode(c) {
  return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
}

function validCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 360;
}

function totals(room) {
  return room.history.reduce(
    (acc, h) => ({ humans: acc.humans + h.humansScore, ai: acc.ai + h.ai.score }),
    { humans: 0, ai: 0 }
  );
}

function publicState(room, forHost) {
  const images = [...room.images.values()];
  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    hostName: room.hostName,
    maxPlayers: MAX_PLAYERS,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, guessed: room.guesses.has(p.id) })),
    settings: room.settings,
    round: room.round,
    totalRounds: room.settings.rounds,
    imageCount: images.length,
    locatedCount: images.filter((i) => i.lat !== null).length,
    images: forHost
      ? images.map((i) => ({ id: i.id, name: i.name, lat: i.lat, lng: i.lng, used: i.used }))
      : undefined,
    currentImageId: room.current,
    aiAvailable: ai.isAvailable(),
    // durante il round solo lo stato dell'IA, mai i contenuti (darebbero indizi ai giocatori)
    aiStatus: room.ai ? { status: room.ai.status, searches: room.ai.searches } : null,
    result: room.phase === 'result' || room.phase === 'final' ? room.lastResult : null,
    final: room.phase === 'final' ? room.final : null,
    totals: totals(room),
  };
}

function broadcast(room) {
  send(room.hostWs, publicState(room, true));
  const pub = publicState(room, false);
  const json = JSON.stringify(pub);
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(json);
}

function broadcastRaw(room, msg) {
  const json = JSON.stringify(msg);
  if (room.hostWs.readyState === 1) room.hostWs.send(json);
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(json);
}

function resetGame(room) {
  room.phase = 'lobby';
  room.round = 0;
  room.current = null;
  room.guesses.clear();
  room.lastResult = null;
  room.history = [];
  room.final = null;
  room.ai = null;
  for (const img of room.images.values()) img.used = false;
}

function reveal(room, force) {
  const img = room.images.get(room.current);
  if (!img) return;
  if (aiBusy(room) && !force) {
    room.phase = 'waiting_ai';
    broadcast(room);
    return;
  }
  const truth = { lat: img.lat, lng: img.lng };
  const S = SCALES[room.settings.scale];

  const guesses = [];
  for (const [pid, g] of room.guesses) {
    const p = room.players.get(pid);
    if (!p) continue;
    const dist = haversine(truth, g);
    guesses.push({ id: pid, name: p.name, lat: g.lat, lng: g.lng, dist, score: score(dist, S) });
  }
  guesses.sort((a, b) => a.dist - b.dist);
  const best = guesses[0] || null;

  const task = room.ai;
  let aiRes;
  if (task && task.status === 'done') {
    const r = task.result;
    const dist = haversine(truth, r);
    aiRes = { ...r, dist, score: score(dist, S), error: null };
  } else {
    const error = task && task.status === 'error' ? task.error : "risultati rivelati prima che l'IA rispondesse";
    aiRes = { lat: null, lng: null, dist: null, score: 0, error };
  }
  room.ai = null; // eventuale risposta tardiva verrà ignorata

  const humansScore = best ? best.score : 0;
  const winner = humansScore > aiRes.score ? 'humans' : humansScore < aiRes.score ? 'ai' : 'tie';

  room.lastResult = {
    round: room.round,
    imageId: room.current,
    truth,
    ai: aiRes,
    guesses,
    best,
    humansScore,
    winner,
    playersCount: room.players.size,
  };
  room.history.push({
    round: room.round,
    imageId: room.current,
    best: best ? { id: best.id, name: best.name, dist: best.dist, score: best.score } : null,
    humansScore,
    ai: { dist: aiRes.dist, score: aiRes.score, error: aiRes.error },
    winner,
  });
  room.phase = 'result';
  broadcast(room);
}

function finish(room) {
  const t = totals(room);
  const counts = new Map();
  for (const h of room.history) {
    if (!h.best) continue;
    const c = counts.get(h.best.id) || { name: h.best.name, rounds: 0, points: 0 };
    c.rounds += 1;
    c.points += h.best.score;
    counts.set(h.best.id, c);
  }
  const mvp = [...counts.values()].sort((a, b) => b.rounds - a.rounds || b.points - a.points)[0] || null;
  room.final = {
    humansTotal: t.humans,
    aiTotal: t.ai,
    winner: t.humans > t.ai ? 'humans' : t.humans < t.ai ? 'ai' : 'tie',
    rounds: room.history,
    mvp,
  };
  room.phase = 'final';
  broadcast(room);
}

function maybeAutoReveal(room) {
  if (room.phase !== 'round' || room.players.size === 0) return false;
  for (const id of room.players.keys()) if (!room.guesses.has(id)) return false;
  reveal(room);
  return true;
}

function leave(ws) {
  const meta = ws.meta;
  if (!meta || !meta.code) return;
  const room = rooms.get(meta.code);
  ws.meta = { id: meta.id };
  if (!room) return;

  if (room.hostId === meta.id) {
    for (const p of room.players.values()) {
      send(p.ws, { t: 'closed', reason: "L'host ha chiuso la stanza." });
      p.ws.meta = { id: p.ws.meta.id };
    }
    rooms.delete(room.code);
    console.log(`[stanza ${room.code}] chiusa`);
    return;
  }

  room.players.delete(meta.id);
  room.guesses.delete(meta.id);
  if (!maybeAutoReveal(room)) broadcast(room);
}

/* ------------------------------------------------------------- Messaggi */

const handlers = {
  create(ws, m) {
    const code = cleanCode(m.code);
    const name = cleanName(m.name);
    if (code.length < 3) return sendError(ws, 'Il codice stanza deve avere almeno 3 caratteri (lettere o numeri).', 'entry');
    if (!name) return sendError(ws, 'Inserisci un username.', 'entry');
    if (rooms.has(code)) return sendError(ws, 'Questo codice stanza è già in uso: scegline un altro.', 'entry');
    leave(ws);
    const room = {
      code,
      hostId: ws.meta.id,
      hostName: name,
      hostWs: ws,
      players: new Map(),
      images: new Map(),
      settings: { rounds: 3, scale: 'world', aiTools: true },
      ai: null,
      phase: 'lobby',
      round: 0,
      current: null,
      guesses: new Map(),
      lastResult: null,
      history: [],
      final: null,
    };
    rooms.set(code, room);
    ws.meta = { id: ws.meta.id, code, role: 'host' };
    send(ws, { t: 'joined', code, you: { id: ws.meta.id, name, isHost: true } });
    broadcast(room);
    console.log(`[stanza ${code}] creata da ${name}`);
  },

  join(ws, m) {
    const code = cleanCode(m.code);
    const name = cleanName(m.name);
    const room = rooms.get(code);
    if (!name) return sendError(ws, 'Inserisci un username.', 'entry');
    if (!room) return sendError(ws, 'Nessuna stanza con questo codice.', 'entry');
    if (room.phase !== 'lobby') return sendError(ws, 'La partita in questa stanza è già iniziata.', 'entry');
    if (room.players.size >= MAX_PLAYERS) return sendError(ws, `La stanza è piena (massimo ${MAX_PLAYERS} giocatori).`, 'entry');
    const lower = name.toLowerCase();
    const taken =
      room.hostName.toLowerCase() === lower || [...room.players.values()].some((p) => p.name.toLowerCase() === lower);
    if (taken) return sendError(ws, 'Username già usato in questa stanza.', 'entry');
    leave(ws);
    room.players.set(ws.meta.id, { id: ws.meta.id, name, ws });
    ws.meta = { id: ws.meta.id, code, role: 'player' };
    send(ws, { t: 'joined', code, you: { id: ws.meta.id, name, isHost: false } });
    broadcast(room);
  },

  leave(ws) {
    leave(ws);
  },

  // ---- comandi dell'host ----
  addImage(ws, m, room) {
    if (room.phase !== 'lobby') return sendError(ws, 'Le foto si possono aggiungere solo in lobby.');
    if (room.images.size >= MAX_IMAGES) return sendError(ws, `Massimo ${MAX_IMAGES} foto per stanza.`);
    const id = String(m.id || '').slice(0, 40);
    const dataUrl = String(m.dataUrl || '');
    if (!id || room.images.has(id)) return sendError(ws, 'Identificativo foto non valido.');
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl) || dataUrl.length > MAX_IMAGE_CHARS)
      return sendError(ws, 'Formato o dimensione della foto non validi.');
    const hasPos = validCoord(m.lat, m.lng);
    room.images.set(id, {
      id,
      name: String(m.name || 'foto').slice(0, 60),
      dataUrl,
      lat: hasPos ? m.lat : null,
      lng: hasPos ? normLng(m.lng) : null,
      used: false,
    });
    broadcast(room);
  },

  setImageLocation(ws, m, room) {
    const img = room.images.get(m.id);
    if (!img || room.phase !== 'lobby') return;
    if (!validCoord(m.lat, m.lng)) return sendError(ws, 'Coordinate non valide.');
    img.lat = m.lat;
    img.lng = normLng(m.lng);
    broadcast(room);
  },

  removeImage(ws, m, room) {
    if (room.phase !== 'lobby') return;
    room.images.delete(m.id);
    broadcast(room);
  },

  settings(ws, m, room) {
    if (room.phase !== 'lobby') return;
    const rounds = Math.round(Number(m.rounds));
    if (Number.isFinite(rounds)) room.settings.rounds = Math.max(1, Math.min(MAX_ROUNDS, rounds));
    if (SCALES[m.scale]) room.settings.scale = m.scale;
    if (typeof m.aiTools === 'boolean') room.settings.aiTools = m.aiTools;
    broadcast(room);
  },

  start(ws, m, room) {
    if (room.phase !== 'lobby') return;
    if (room.players.size < 1) return sendError(ws, 'Serve almeno un giocatore collegato.');
    const located = [...room.images.values()].filter((i) => i.lat !== null).length;
    if (located < room.settings.rounds)
      return sendError(ws, `Servono almeno ${room.settings.rounds} foto con posizione (ora ${located}).`);
    resetGame(room);
    room.phase = 'select';
    broadcast(room);
    console.log(`[stanza ${room.code}] partita avviata con ${room.players.size} giocatori`);
  },

  selectImage(ws, m, room) {
    if (room.phase !== 'select') return;
    const img = room.images.get(m.id);
    if (!img || img.used || img.lat === null) return sendError(ws, 'Foto non disponibile.');
    img.used = true;
    room.round += 1;
    room.current = img.id;
    room.guesses.clear();
    room.phase = 'round';
    startAi(room, img.dataUrl); // solo i pixel: niente coordinate, niente nome file
    broadcastRaw(room, { t: 'round', round: room.round, total: room.settings.rounds, imageId: img.id, dataUrl: img.dataUrl });
    broadcast(room);
  },

  reveal(ws, m, room) {
    if (room.phase === 'round') reveal(room);
  },

  revealNow(ws, m, room) {
    if (room.phase === 'waiting_ai') reveal(room, true);
  },

  next(ws, m, room) {
    if (room.phase !== 'result') return;
    if (room.round >= room.settings.rounds) return finish(room);
    room.phase = 'select';
    room.current = null;
    room.guesses.clear();
    broadcast(room);
  },

  restart(ws, m, room) {
    resetGame(room);
    broadcast(room);
  },

  // ---- comandi dei giocatori ----
  guess(ws, m, room) {
    if (room.phase !== 'round') return;
    if (room.guesses.has(ws.meta.id)) return sendError(ws, 'Hai già inviato il tuo guess per questo round.');
    if (!validCoord(m.lat, m.lng)) return sendError(ws, 'Coordinate non valide.');
    room.guesses.set(ws.meta.id, { lat: m.lat, lng: normLng(m.lng) });
    if (!maybeAutoReveal(room)) broadcast(room);
  },
};

const HOST_ONLY = new Set(['addImage', 'setImageLocation', 'removeImage', 'settings', 'start', 'selectImage', 'reveal', 'revealNow', 'next', 'restart']);
const PLAYER_ONLY = new Set(['guess']);

wss.on('connection', (ws) => {
  ws.meta = { id: 'u' + nextId++ };
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const fn = handlers[m && m.t];
    if (!fn) return;

    if (m.t === 'create' || m.t === 'join' || m.t === 'leave') return fn(ws, m);

    const room = ws.meta.code && rooms.get(ws.meta.code);
    if (!room) return sendError(ws, 'Non sei in nessuna stanza.');
    if (HOST_ONLY.has(m.t) && ws.meta.role !== 'host') return sendError(ws, "Comando riservato all'host.");
    if (PLAYER_ONLY.has(m.t) && ws.meta.role !== 'player') return;
    fn(ws, m, room);
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// Heartbeat: chiude le connessioni morte
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`\nCyber OSINT Lab in ascolto sulla porta ${PORT}`);
  console.log(`  Locale:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  Rete:    http://${a.address}:${PORT}`);
    }
  }
  if (ai.isAvailable()) console.log(`  IA:      Gemini (${ai.MODELS.join(' → ')})`);
  else console.log("  IA:      ATTENZIONE, GEMINI_API_KEY non impostata: l'IA non potrà giocare");
  console.log('');
});
