'use strict';

/*
 * IA avversaria: geolocalizza una foto guardando SOLO l'immagine.
 *
 * - Modello: Google Gemini (piano gratuito, chiave in GEMINI_API_KEY).
 * - Strumenti opzionali: ricerche su OpenStreetMap (Nominatim / Photon),
 *   gratuite e senza chiave, per trasformare insegne, vie e monumenti
 *   letti nella foto in coordinate precise.
 *
 * La funzione geolocate() riceve esclusivamente i byte dell'immagine:
 * nessuna coordinata, nessun nome file, nessun dato della partita.
 */

const { GoogleGenAI } = require('@google/genai');

const UA = 'CyberOSINTLab/1.0 (educational game)';
// Ordine di preferenza (verificato sul piano gratuito: gemini-3.8-flash può restare
// in attesa senza mai rispondere, quindi non è il default)
const DEFAULT_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const MODELS = [...new Set([process.env.AI_MODEL, ...DEFAULT_MODELS].filter(Boolean))];
// Piano gratuito: ~5 richieste/minuto per modello → pochi turni, ricerche in parallelo
const MAX_TOOL_TURNS = 4;
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 180000;
const CALL_TIMEOUT_MS = 60000; // singola richiesta: oltre, il modello è considerato bloccato
const FINAL_RESERVE_MS = 45000; // tempo riservato per la risposta finale

const isAvailable = () => !!process.env.GEMINI_API_KEY;

let client = null;
function getClient() {
  // niente retry automatici dell'SDK: su 429 si passa subito al modello successivo
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { retryOptions: { attempts: 1 } } });
  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------- OpenStreetMap tools */

// Policy Nominatim: massimo 1 richiesta al secondo, User-Agent identificativo
let osmChain = Promise.resolve();
let lastOsm = 0;
function osmFetch(url) {
  const job = osmChain.then(async () => {
    const wait = lastOsm + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastOsm = Date.now();
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'it,en' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`servizio mappe HTTP ${res.status}`);
    return res.json();
  });
  osmChain = job.catch(() => {});
  return job;
}

function kmBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function geocode(args) {
  const query = String(args.query || '').slice(0, 200);
  if (!query) return { error: 'query vuota' };
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(query)}`;
  const data = await osmFetch(url);
  return {
    results: data.map((r) => ({
      name: String(r.display_name || '').slice(0, 180),
      type: `${r.category || ''}/${r.type || ''}`,
      lat: Number(r.lat),
      lng: Number(r.lon),
    })),
  };
}

async function searchNearby(args) {
  const query = String(args.query || '').slice(0, 200);
  const lat = Number(args.lat);
  const lng = Number(args.lng);
  const radius = Math.min(Math.max(Number(args.radius_km) || 20, 0.2), 300);
  if (!query || !Number.isFinite(lat) || !Number.isFinite(lng)) return { error: 'servono query, lat e lng' };
  const url = `https://photon.komoot.io/api/?limit=15&q=${encodeURIComponent(query)}&lat=${lat}&lon=${lng}`;
  const data = await osmFetch(url);
  const center = { lat, lng };
  const all = (data.features || []).map((f) => {
    const p = f.properties || {};
    const pos = { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
    return {
      name: p.name || '',
      address: [p.street, p.housenumber, p.city || p.locality, p.country].filter(Boolean).join(', '),
      type: `${p.osm_key || ''}/${p.osm_value || ''}`,
      lat: pos.lat,
      lng: pos.lng,
      distance_km: Math.round(kmBetween(center, pos) * 100) / 100,
    };
  });
  const inside = all.filter((r) => r.distance_km <= radius).sort((a, b) => a.distance_km - b.distance_km);
  if (inside.length) return { results: inside.slice(0, 8) };
  return {
    results: all.sort((a, b) => a.distance_km - b.distance_km).slice(0, 5),
    note: `nessun risultato entro ${radius} km: questi sono i più vicini trovati`,
  };
}

/* ------------------------------------------------------ Prompt & tool */

const SYSTEM = `You are an expert OSINT geolocation analyst competing against a team of humans in a GeoGuessr-style game.
You receive ONE photo with no metadata. Your goal is to find the exact spot where it was taken, minimizing the distance error in meters (full score within 20 m, decaying quickly with distance).

Method:
1. Inspect the image systematically: any readable text (shop names, street signs, posters, menus, license plates, house numbers), language and script, road markings, driving side, bollards, poles, kerbs, architecture and building materials, roofs, vegetation, terrain and mountain profiles, sun position and shadows, weather and climate.
2. Narrow down step by step: country, then region, then city, then neighbourhood and street.
3. Be careful with weak clues: phone prefixes, mobile operators, generic words ("for sale", "pharmacy") and generic architecture are usually national, not local. Do not default to the capital or the most famous city: weigh which cities and regions of that country really match the landscape, climate, vegetation and building style.
4. When map tools are available, use them to verify and pinpoint: geocode specific names (e.g. "shop name + city", "street + city", a landmark), and use search_nearby to look for a sign or business name around your hypothesised area. Prefer precise named features over city centres. If a result does not fit what you see, try another hypothesis.
   Searching is limited to a few turns, so put several independent searches in the SAME turn (parallel function calls) instead of one per turn.
5. Always commit to a single best point, even when unsure: never refuse and never answer with a vague region.
Do not invent text you cannot actually read.

Finish by calling submit_answer. Write "reasoning" and "clues" in Italian, concise and suitable for students.`;

const SUBMIT = {
  name: 'submit_answer',
  description: 'Submit your final single best guess of where the photo was taken. Call exactly once, at the end.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      lat: { type: 'number', description: 'Latitude in decimal degrees' },
      lng: { type: 'number', description: 'Longitude in decimal degrees' },
      confidence: { type: 'number', description: 'Confidence 0-100 that the guess is within 1 km' },
      place: { type: 'string', description: 'Short name of the guessed place (Italian)' },
      reasoning: { type: 'string', description: 'How you deduced the location, 3-6 sentences, in Italian' },
      clues: { type: 'array', items: { type: 'string' }, description: 'Key visual clues used, short phrases in Italian' },
    },
    required: ['lat', 'lng', 'confidence', 'reasoning', 'clues'],
  },
};

const GEOCODE = {
  name: 'geocode',
  description:
    'Search OpenStreetMap for a place by name or address and get coordinates. Use specific queries such as "Bar Centrale, Via Roma, Trento" or "Piazza Duomo Trento".',
  parametersJsonSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Place name and/or address, ideally with city' } },
    required: ['query'],
  },
};

const NEARBY = {
  name: 'search_nearby',
  description:
    'Search OpenStreetMap for a business, sign or landmark name around a hypothesised area. Returns matches sorted by distance from the given point.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Name to look for, e.g. text read on a sign' },
      lat: { type: 'number', description: 'Latitude of the hypothesised area' },
      lng: { type: 'number', description: 'Longitude of the hypothesised area' },
      radius_km: { type: 'number', description: 'Search radius in km (default 20)' },
    },
    required: ['query', 'lat', 'lng'],
  },
};

/* --------------------------------------------------------- Agent loop */

class AiError extends Error {}

function friendlyError(e) {
  if (e instanceof AiError) return e;
  const status = e && e.status;
  if (status === 429) return new AiError('quota gratuita Gemini esaurita: riprova tra un minuto (o domani se è finita la quota giornaliera)');
  if (status === 400 && /api key/i.test(e.message || '')) return new AiError('chiave GEMINI_API_KEY non valida');
  if (status === 401 || status === 403) return new AiError('chiave GEMINI_API_KEY non valida o senza permessi');
  if (e && e.name === 'AbortError') return new AiError('tempo scaduto: l\'IA non ha risposto in tempo');
  return new AiError(`errore del servizio IA (${(e && e.message) || e})`.slice(0, 200));
}

// "Please retry in 12.1s" → 13100 ms; null se non è un limite al minuto (es. quota giornaliera)
function retryDelayMs(e) {
  const msg = String((e && e.message) || '');
  if (/per ?day|PerDay/i.test(msg)) return null;
  const m = /retry in ([\d.]+)s/i.exec(msg) || /"retryDelay":\s*"(\d+)s"/.exec(msg);
  if (!m) return null;
  const ms = Math.ceil(Number(m[1]) * 1000) + 1000;
  return ms <= 35000 ? ms : null;
}

// Errori per cui conviene provare il modello successivo (incluso il modello bloccato)
const retryable = (e) =>
  e && ([404, 429, 500, 503].includes(e.status) || e.name === 'AbortError' || e.name === 'TimeoutError' || e.callTimeout);

function validateAnswer(args, searches, model) {
  const lat = Number(args.lat);
  const lng = Number(args.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new AiError("l'IA ha restituito coordinate non valide");
  }
  return {
    lat,
    lng,
    confidence: Math.max(0, Math.min(100, Math.round(Number(args.confidence) || 0))),
    place: String(args.place || '').slice(0, 120),
    reasoning: String(args.reasoning || '').slice(0, 1500),
    clues: (Array.isArray(args.clues) ? args.clues : []).slice(0, 8).map((c) => String(c).slice(0, 160)),
    searches,
    model,
  };
}

async function runModel(model, image, useTools, onStatus, signal, deadline) {
  const ai = getClient();
  const decls = useTools ? [GEOCODE, NEARBY, SUBMIT] : [SUBMIT];
  const contents = [
    {
      role: 'user',
      parts: [
        { inlineData: { mimeType: image.mimeType, data: image.data } },
        {
          text: useTools
            ? `Where was this photo taken? You have at most ${MAX_TOOL_TURNS} turns of map searches (several searches per turn are allowed and encouraged), then call submit_answer.`
            : 'Where was this photo taken? No map tools are available this time: reason from the image alone, then call submit_answer.',
        },
      ],
    },
  ];
  const searches = [];
  let quotaWaits = 0;

  for (let turn = 0; turn <= MAX_TOOL_TURNS + 1; turn++) {
    const remaining = deadline - Date.now();
    const lastTurn = !useTools || turn >= MAX_TOOL_TURNS || remaining < FINAL_RESERVE_MS;
    const functionCallingConfig = { mode: 'ANY' };
    if (lastTurn) functionCallingConfig.allowedFunctionNames = ['submit_answer'];

    const callSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, Math.max(remaining, 1000)))]);
    let res;
    try {
      res = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: SYSTEM,
          tools: [{ functionDeclarations: decls }],
          toolConfig: { functionCallingConfig },
          thinkingConfig: { thinkingLevel: 'HIGH' },
          abortSignal: callSignal,
        },
      });
    } catch (e) {
      if (callSignal.aborted && !signal.aborted) {
        const err = new Error(`nessuna risposta entro ${Math.round(CALL_TIMEOUT_MS / 1000)} s`);
        err.callTimeout = true;
        throw err;
      }
      // Limite al minuto: aspetta e riprova lo stesso turno, senza perdere il lavoro fatto
      const delay = e.status === 429 ? retryDelayMs(e) : null;
      if (delay !== null && quotaWaits < 2 && deadline - Date.now() > delay + FINAL_RESERVE_MS) {
        quotaWaits += 1;
        onStatus({ phase: 'waiting_quota', count: searches.length });
        await sleep(delay);
        turn -= 1;
        continue;
      }
      throw e;
    }

    const calls = res.functionCalls || [];
    const content = res.candidates && res.candidates[0] && res.candidates[0].content;

    const submit = calls.find((c) => c.name === 'submit_answer');
    if (submit) return validateAnswer(submit.args || {}, searches, model);

    if (content) contents.push(content); // conserva anche le thought signatures
    if (!calls.length) {
      contents.push({ role: 'user', parts: [{ text: 'Call submit_answer with your best guess now.' }] });
      continue;
    }

    onStatus({ phase: 'searching', count: searches.length + calls.length });
    const parts = await Promise.all(
      calls.map(async (c) => {
        const args = c.args || {};
        let out;
        try {
          if (c.name === 'geocode') out = await geocode(args);
          else if (c.name === 'search_nearby') out = await searchNearby(args);
          else out = { error: `strumento sconosciuto: ${c.name}` };
        } catch (e) {
          out = { error: e.message };
        }
        searches.push({
          tool: c.name,
          query: String(args.query || '').slice(0, 200),
          results: Array.isArray(out.results) ? out.results.length : 0,
        });
        const fr = { name: c.name, response: out };
        if (c.id) fr.id = c.id;
        return { functionResponse: fr };
      })
    );
    contents.push({ role: 'user', parts });
  }
  throw new AiError("l'IA non ha fornito una risposta finale");
}

/**
 * @param {string} dataUrl  immagine come data URL (JPEG/PNG/WebP), già priva di metadati
 * @param {{tools?: boolean, onStatus?: (s: {phase: string, count?: number}) => void}} opts
 */
async function geolocate(dataUrl, opts = {}) {
  if (!isAvailable()) throw new AiError('chiave GEMINI_API_KEY non configurata sul server');
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(dataUrl));
  if (!m) throw new AiError('formato immagine non supportato');
  const image = { mimeType: m[1], data: m[2] };
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const deadline = Date.now() + TIMEOUT_MS;

  let lastErr;
  for (const model of MODELS) {
    if (deadline - Date.now() < 15000) break;
    try {
      return await runModel(model, image, opts.tools !== false, onStatus, signal, deadline);
    } catch (e) {
      lastErr = e;
      console.warn(`[IA] ${model}: ${e.status || ''} ${e.message}`);
      if (!retryable(e) || signal.aborted) break;
    }
  }
  if (signal.aborted) throw new AiError("tempo scaduto: l'IA non ha risposto entro " + Math.round(TIMEOUT_MS / 1000) + ' s');
  throw friendlyError(lastErr);
}

module.exports = { geolocate, isAvailable, MODELS };
