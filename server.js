// Thought Visualizer — local observation server.
// Pure Node.js stdlib: http, fs, path, url. Nothing to `npm install`.
// - GET  /                   → serves index.html and assets
// - GET  /stream             → Server-Sent Events; broadcasts observations
// - POST /observe            → accepts JSON observation, broadcasts it
// - GET  /think?prompt=...   → optional: streams extended thinking from
//                              Anthropic API (needs @anthropic-ai/sdk + key).
//
// The visualizer at file:///.../index.html connects here via CORS.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HIST_LIMIT = 200;

const clients = new Set();
const history = [];

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

function broadcast(obs) {
  const evName = (obs.type || 'observation').replace(/[^a-z0-9_]/gi, '_');
  const data = JSON.stringify(obs);
  const frame = `event: ${evName}\ndata: ${data}\n\n`;
  for (const res of [...clients]) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
  history.push({ frame, obs });
  if (history.length > HIST_LIMIT) history.shift();
}

function serveStatic(req, res) {
  const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(__dirname, p);
  if (!file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const ext = path.extname(file);
  const type = ext === '.html' ? 'text/html; charset=utf-8'
             : ext === '.js'   ? 'application/javascript'
             : ext === '.css'  ? 'text/css'
             : 'application/octet-stream';
  cors(res);
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(file).pipe(res);
}

function handleStream(req, res) {
  cors(res);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`: connected ${Date.now()}\n\n`);
  clients.add(res);
  // Replay recent history so newly-opened tabs pick up ongoing context.
  for (const h of history) { try { res.write(h.frame); } catch {} }
  // Heartbeat every 15s so proxies / OS don't kill the connection.
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 15000);
  req.on('close', () => { clearInterval(hb); clients.delete(res); });
}

function handleObserve(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1_000_000) req.destroy(); });
  req.on('end', () => {
    let obs;
    try { obs = JSON.parse(body || '{}'); }
    catch { res.writeHead(400); res.end('bad json'); return; }
    if (!obs.type) obs.type = 'observation';
    obs.ts = Date.now();
    broadcast(obs);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}

// --- Optional live Anthropic API streaming -------------------------------
let anthropicPromise = null;
async function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropicPromise) {
    anthropicPromise = (async () => {
      try {
        const mod = await import('@anthropic-ai/sdk');
        const Anthropic = mod.default || mod.Anthropic;
        return new Anthropic();
      } catch (e) {
        console.log('  live mode: @anthropic-ai/sdk not installed — skipping');
        return null;
      }
    })();
  }
  return anthropicPromise;
}

async function handleThink(req, res) {
  cors(res);
  const url = new URL(req.url, 'http://x');
  const prompt = url.searchParams.get('prompt') || 'Pomyśl na głos.';

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  });

  const client = await getAnthropic();
  if (!client) {
    res.write(`event: thought\ndata: ${JSON.stringify({ text: 'Live mode niedostępny — brak ANTHROPIC_API_KEY lub @anthropic-ai/sdk.' })}\n\n`);
    res.write(`event: done\ndata: 1\n\n`); res.end(); return;
  }

  let buf = '';
  const flush = (final = false) => {
    const parts = buf.split(/(?<=[.!?…])\s+/);
    if (!final) buf = parts.pop() || ''; else buf = '';
    for (const s of parts) {
      const clean = s.trim();
      if (!clean) continue;
      const data = JSON.stringify({ text: clean.replace(/\n/g, ' ') });
      res.write(`event: thought\ndata: ${data}\n\n`);
      broadcast({ type: 'assistant_thought', text: clean });
    }
  };

  try {
    const stream = client.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: 3000 },
      messages: [{ role: 'user', content:
        `Rozważ na głos następujące zagadnienie w krótkich, konkretnych zdaniach. Nie odpowiadaj — tylko myśl. Zagadnienie: ${prompt}` }],
    });
    stream.on('thinking', (delta) => { if (typeof delta === 'string') { buf += delta; flush(false); } });
    stream.on('end',      () => { flush(true); res.write(`event: done\ndata: 1\n\n`); res.end(); });
    stream.on('error',    (err) => {
      res.write(`event: thought\ndata: ${JSON.stringify({ text: `[błąd: ${String(err).slice(0, 200)}]` })}\n\n`);
      res.write(`event: done\ndata: 1\n\n`); res.end();
    });
  } catch (err) {
    res.write(`event: thought\ndata: ${JSON.stringify({ text: `[nie mogę połączyć się z API: ${String(err).slice(0, 200)}]` })}\n\n`);
    res.write(`event: done\ndata: 1\n\n`); res.end();
  }
}

// --- Skill card generation -----------------------------------------------
// When a user clicks a neuron in the visualizer, the frontend asks us to
// turn that concept into a small "skill you can practice in daily life"
// card. If Anthropic is available we ask Haiku; otherwise a templated card.
async function handleSkill(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://x');
  const word = (url.searchParams.get('word') || '').slice(0, 60).trim();
  if (!word) { res.writeHead(400); res.end('{"error":"no word"}'); return; }

  const client = await getAnthropic();
  let card = null;
  if (client) {
    try {
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content:
`Zamień pojęcie "${word}" w kartę mikro-skilla do praktykowania w codziennym życiu.
Odpowiedz WYŁĄCZNIE JSON-em (bez otoczki, bez markdown code fences) o strukturze:
{
  "skill": "krótka, aspiracyjna nazwa umiejętności (max 4 słowa)",
  "why": "jedno zdanie: co się zmieni, jeśli będę to praktykować",
  "practice": ["3 konkretne praktyki w trybie rozkazującym", "każda 4-10 słów", "wykonalna dziś"],
  "quote": "krótki cytat lub aforyzm oddający sedno (max 12 słów)"
}
Odpowiedź po polsku. Bez emoji.` }],
      });
      const text = (msg.content?.[0]?.text || '').trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (m) card = JSON.parse(m[0]);
    } catch (e) { console.log('skill-gen error:', e.message); }
  }
  if (!card) {
    card = {
      skill: word.charAt(0).toUpperCase() + word.slice(1),
      why: `Świadome uchwycenie "${word}" zmienia sposób, w jaki się nim posługujesz.`,
      practice: [
        `Nazwij "${word}" na głos, gdy je zauważysz w dziale dnia.`,
        `Zapisz jeden konkretny przykład dziennie przez siedem dni.`,
        `Zadaj sobie wieczorem: kiedy dziś zrobiłem to nieświadomie?`,
      ],
      quote: 'Uwaga jest wielokrotnie działającą dźwignią.',
    };
  }
  card.word = word;
  card.ts = Date.now();
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(card));
}

// --- Router --------------------------------------------------------------
http.createServer((req, res) => {
  if (req.url.startsWith('/stream'))  return handleStream(req, res);
  if (req.url.startsWith('/observe')) return handleObserve(req, res);
  if (req.url.startsWith('/think'))   return handleThink(req, res);
  if (req.url.startsWith('/skill'))   return handleSkill(req, res);
  return serveStatic(req, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  🧠  Thought Visualizer  →  http://localhost:${PORT}`);
  console.log(`      SSE:      http://localhost:${PORT}/stream`);
  console.log(`      Observe:  POST http://localhost:${PORT}/observe`);
  console.log(`      Open the visualizer at:  file://${path.join(__dirname, 'index.html')}\n`);
});
