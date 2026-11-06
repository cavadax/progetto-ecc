/* Difesa Digitale: gioco Giocatori vs IA. Stato condiviso via localStorage + BroadcastChannel (multi-tab). */
"use strict";
const CFG = { MAX: 30, DURATION: 120, TICK: 1000, QPTS: 9, PENALTY: 3 };
const QUIZ = [
  ["Un'email urgente della banca chiede di cliccare un link. Cosa fai?", ["Clicco subito", "Apro il sito ufficiale digitando l'indirizzo", "Rispondo con i miei dati"], 1],
  ["Quale password è più sicura?", ["Nome123", "Una frase lunga e unica, in un password manager", "La stessa ovunque"], 1],
  ["Cosa aggiunge l'autenticazione a due fattori?", ["Un secondo controllo oltre alla password", "Più pubblicità", "Nulla di utile"], 0],
  ["Un'IA genera una risposta sicura di sé. Cosa è corretto?", ["È sempre vera", "Va verificata con fonti affidabili", "Va condivisa subito"], 1],
  ["Cos'è il bias in un algoritmo?", ["Una distorsione ereditata dai dati", "Un virus", "Un tipo di cifratura"], 0],
  ["Una videochiamata del 'capo' chiede un bonifico urgente. Cosa fai?", ["Pago", "Verifico con un altro canale", "Inoltro i codici"], 1],
  ["Ogni quanto conviene aggiornare i dispositivi?", ["Appena disponibili gli aggiornamenti", "Mai", "Una volta l'anno"], 0],
  ["Dati sensibili e strumenti di IA sconosciuti:", ["Li incollo senza problemi", "Evito di condividerli", "Li pubblico"], 1]
];
const $ = id => document.getElementById(id);

/* --- Modulo Store: stato condiviso --- */
const Store = {
  bc: "BroadcastChannel" in window ? new BroadcastChannel("difesa-digitale") : null,
  key: c => "dd:" + c,
  get(c) { try { return JSON.parse(localStorage.getItem(this.key(c))); } catch { return null; } },
  // Aggiorna atomicamente (per quanto possibile) lo stato e notifica le altre schede
  update(c, fn) { const s = this.get(c); if (!s) return null; fn(s); localStorage.setItem(this.key(c), JSON.stringify(s)); this.bc && this.bc.postMessage(c); return s; },
  create(c, s) { localStorage.setItem(this.key(c), JSON.stringify(s)); }
};

/* --- Modulo Game: logica pura --- */
const Game = {
  log(s, msg) { s.log.push(msg); if (s.log.length > 60) s.log.shift(); },
  avg(s) { const p = Object.values(s.players); return p.reduce((a, x) => a + x.pos, 0) / (p.length || 1); },
  best(s) { return Math.max(0, ...Object.values(s.players).map(x => x.pos)); },
  // Un tick dell'host: l'IA avanza con difficoltà crescente, i bot rispondono
  tick(s) {
    if (s.phase !== "play") return;
    const left = Math.max(0, Math.round((s.end - Date.now()) / 1000)), el = CFG.DURATION - left;
    const speed = 0.5 + el / 260 + (s.surge ? 0.5 : 0);
    s.ai = Math.min(100, s.ai + speed);
    if (Math.random() < 0.04) { s.surge = !s.surge; this.log(s, s.surge ? "L'IA ha accelerato" : "L'IA rallenta per ricalibrarsi"); }
    for (const [n, p] of Object.entries(s.players)) if (p.bot && Math.random() < 0.35) {
      const ok = Math.random() < 0.7; p.pos = Math.max(0, Math.min(100, p.pos + (ok ? CFG.QPTS : -CFG.PENALTY)));
      if (ok && Math.random() < 0.3) this.log(s, `${n} ha sbloccato una barriera`);
    }
    if (this.best(s) >= 100) return this.finish(s, true, "Un giocatore ha raggiunto il traguardo.");
    if (s.ai >= 100) return this.finish(s, false, "Svolta di sicurezza compromessa: l'IA ha raggiunto il server.");
    if (left <= 0) this.finish(s, this.best(s) > s.ai, this.best(s) > s.ai ? "Tempo scaduto: i giocatori erano più vicini del traguardo." : "Tempo scaduto: l'IA era in vantaggio.");
  },
  finish(s, win, why) { s.phase = "end"; s.result = { win, why }; this.log(s, why); }
};

/* --- Modulo UI + controller --- */
const App = {
  code: null, me: null, qi: 0, order: [], timer: null,
  init() {
    $("create").onclick = () => this.enter(true);
    $("joinBtn").onclick = () => this.enter(false);
    $("ready").onclick = () => this.mutate(s => { s.players[this.me].ready = !s.players[this.me].ready; });
    $("bots").onclick = () => this.mutate(s => { for (let i = 1; i <= 5 && Object.keys(s.players).length < CFG.MAX; i++) { const n = "Bot" + (Object.keys(s.players).length + 1); s.players[n] = { ready: true, pos: 0, bot: true }; } });
    $("start").onclick = () => this.mutate(s => { s.phase = "play"; s.end = Date.now() + CFG.DURATION * 1000; s.log = []; Game.log(s, "Partita avviata: metti in sicurezza il server!"); Object.values(s.players).forEach(p => p.pos = 0); });
    const render = c => c === this.code && this.render();
    if (Store.bc) Store.bc.onmessage = e => render(e.data);
    addEventListener("storage", e => e.key && e.key.startsWith("dd:") && render(e.key.slice(3)));
  },
  err(m) { $("err").textContent = m; },
  mutate(fn) { Store.update(this.code, fn); this.render(); },
  enter(create) {
    const name = $("name").value.trim(), code = $("code").value.trim().toUpperCase();
    if (!name) return this.err("Inserisci un nome utente.");
    if (!/^[A-Z0-9]{4}$/.test(code)) return this.err("Il codice deve avere 4 caratteri alfanumerici.");
    const s = Store.get(code);
    if (create) { if (s) return this.err("Questo codice esiste già: scegline un altro o unisciti."); Store.create(code, { code, host: name, phase: "lobby", players: { [name]: { ready: true, pos: 0 } }, ai: 0, log: [] }); }
    else {
      if (!s) return this.err("Stanza non trovata: controlla il codice o creane una nuova.");
      if (s.players[name] && s.host !== name) return this.err("Nome già in uso nella stanza.");
      if (!s.players[name] && Object.keys(s.players).length >= CFG.MAX) return this.err("La stanza è piena (30 giocatori).");
      if (s.phase !== "lobby" && !s.players[name]) return this.err("La partita è già iniziata.");
      Store.update(code, x => { x.players[name] = x.players[name] || { ready: false, pos: 0 }; });
    }
    this.code = code; this.me = name; this.err("");
    this.timer = setInterval(() => this.loop(), CFG.TICK); this.nextQ(); this.render();
  },
  loop() {
    const s = Store.get(this.code); if (!s) return;
    if (s.host === this.me && s.phase === "play") Store.update(this.code, Game.tick.bind(Game));
    this.render();
  },
  render() {
    const s = Store.get(this.code); if (!s) return;
    const host = s.host === this.me, names = Object.keys(s.players);
    $("join").classList.add("hidden");
    $("lobby").classList.toggle("hidden", s.phase !== "lobby");
    $("play").classList.toggle("hidden", s.phase === "lobby");
    if (s.phase === "lobby") {
      $("lcode").textContent = s.code; $("count").textContent = names.length;
      $("plist").innerHTML = names.map(n => `<li>${esc(n)}${n === s.host ? " (host)" : ""}<span class="tag ${s.players[n].ready ? "ok" : ""}">${s.players[n].ready ? "Pronto" : "In attesa"}</span></li>`).join("");
      $("start").classList.toggle("hidden", !host); $("bots").classList.toggle("hidden", !host);
      $("wait").classList.toggle("hidden", host);
      $("ready").textContent = s.players[this.me].ready ? "Annulla pronto" : "Segna come pronto";
      return;
    }
    const left = Math.max(0, Math.round((s.end - Date.now()) / 1000));
    $("timer").textContent = s.phase === "end" ? 0 : left;
    $("dAi").textContent = Math.round(100 - s.ai); $("dTeam").textContent = Math.round(100 - Game.avg(s));
    const lane = (n, cls, pos, txt) => `<div class="lane ${cls}" title="${esc(n)}"><span class="dot" style="left:${pos}%">${txt}</span></div>`;
    $("track").innerHTML = '<div class="finish"></div>' + lane("IA", "ai", s.ai, "IA") + names.map((n, i) => lane(n, n === this.me ? "me" : "", s.players[n].pos, i + 1)).join("");
    $("log").innerHTML = s.log.slice().reverse().map(l => `<li>${esc(l)}</li>`).join("");
    const end = $("endbox"); end.classList.toggle("hidden", s.phase !== "end");
    if (s.phase === "end") { end.className = "end " + (s.result.win ? "win" : "lose"); end.textContent = (s.result.win ? "Vincono i giocatori. " : "Vince l'IA. ") + s.result.why; $("opts").innerHTML = ""; }
  },
  nextQ() {
    if (!this.order.length) this.order = QUIZ.map((_, i) => i).sort(() => Math.random() - .5);
    this.qi = this.order.pop(); const [q, opts] = QUIZ[this.qi];
    $("q").textContent = q;
    $("opts").innerHTML = opts.map((o, i) => `<button class="btn opt" data-i="${i}">${esc(o)}</button>`).join("");
    $("opts").querySelectorAll("button").forEach(b => b.onclick = () => this.answer(+b.dataset.i));
  },
  answer(i) {
    const s = Store.get(this.code); if (!s || s.phase !== "play") return;
    const ok = i === QUIZ[this.qi][2];
    $("fb").textContent = ok ? "Corretto: barriera sbloccata." : "Errato: l'IA guadagna terreno.";
    Store.update(this.code, x => { const p = x.players[this.me]; p.pos = Math.max(0, Math.min(100, p.pos + (ok ? CFG.QPTS : -CFG.PENALTY))); if (ok) Game.log(x, `${this.me} ha sbloccato una barriera`); else Game.log(x, `${this.me} ha sbagliato una risposta`); if (p.pos >= 100) Game.finish(x, true, `${this.me} ha raggiunto il traguardo.`); });
    this.nextQ(); this.render();
  }
};
function esc(t) { return String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
App.init();
