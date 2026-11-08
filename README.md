# Cyber OSINT Lab

SPA formativa sulla sicurezza informatica (4 moduli teorici) + gioco multiplayer cooperativo **Umani vs IA** in stile "indovina il luogo dalla foto".

## 1. Chiave IA gratuita (Google Gemini)

L'avversario è una vera IA di visione, **Google Gemini**, sul piano gratuito.

1. Vai su <https://aistudio.google.com>, accedi con un account Google e clicca **Get API key** → *Create API key*. Non serve una carta di credito.
2. Copia la chiave.

Limiti del piano gratuito: un tetto al minuto e uno giornaliero per progetto (li vedi in AI Studio). Il limite tipico è 5 richieste al minuto per modello. Ogni round ne usa da 1 a 5, perché l'IA raggruppa le ricerche sulle mappe; se il limite al minuto scatta, il server attende qualche secondo e riprova senza perdere il lavoro fatto. Se la quota del modello principale finisce, il server passa da solo ai modelli "lite". Nel piano gratuito Google può usare i contenuti inviati per migliorare i propri servizi: evita foto con persone riconoscibili.

## 2. Avvio

```bash
npm install
echo "GEMINI_API_KEY=la_tua_chiave" > .env      # una volta sola: la chiave resta nel file .env
npm start                                       # porta 3000
```

In alternativa: `GEMINI_API_KEY=la_tua_chiave npm start`.

Opzioni (variabili d'ambiente):

| Variabile | Default | Significato |
|---|---|---|
| `GEMINI_API_KEY` | (nessuna) | chiave Gemini; senza chiave l'IA prende 0 punti |
| `AI_MODEL` | `gemini-3.6-flash` | modello preferito (poi fallback su `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`) |
| `AI_TIMEOUT_MS` | `180000` | tempo massimo di ragionamento dell'IA per round |
| `PORT` | `3000` | porta HTTP |

Il terminale mostra l'indirizzo di rete (es. `http://192.168.1.65:3000`) da aprire sui dispositivi dei giocatori.

## Come gioca l'IA

- Quando l'host proietta una foto, il server la invia a Gemini **senza metadati, senza nome file e senza coordinate**: l'IA vede solo i pixel, esattamente come i giocatori.
- L'IA analizza scritte, lingua, segnaletica, architettura, vegetazione, ombre… Se l'host lascia attivo *"L'IA può consultare le mappe"*, può anche cercare su OpenStreetMap (Nominatim / Photon, gratuiti) le insegne e le vie che legge, per fissare il punto esatto.
- Durante il round i giocatori vedono solo lo stato dell'IA (osserva / consulta le mappe / ha risposto). Ragionamento, indizi e ricerche vengono mostrati solo nei risultati.
- Se l'host rivela prima che l'IA abbia finito, la partita attende. L'host può forzare con "Rivela senza IA" (0 punti all'IA).

## Come si gioca

1. **Host** → tab *5 · Gioco* → *Crea lobby* (codice stanza + username).
2. **Giocatori** (max 30) → *Unisciti* con lo stesso codice.
3. L'host carica le foto. Se una foto ha il GPS nei metadati EXIF, la posizione viene letta da sola (momento didattico); altrimenti la si imposta sulla mappa. Prima dell'invio le foto vengono ri-codificate e i metadati spariscono.
4. *Start Partita* → a ogni round l'host sceglie la foto, i giocatori piazzano **un solo guess** sulla mappa in basso a destra.
5. Punteggio: 5000 punti entro 20 m, poi `5000 · e^(-(d-20)/S)` con S = scala scelta (Città 1 km, Regione 50 km, Mondo 1500 km). Per la squadra conta il miglior giocatore del round.

## File

- `server.js`: server HTTP + WebSocket, stato delle stanze in memoria.
- `ai.js`: agente IA (Gemini + strumenti OpenStreetMap). Riceve solo l'immagine.
- `public/index.html`: l'intera SPA (Tailwind CDN, Leaflet + OpenStreetMap, JavaScript vanilla).
