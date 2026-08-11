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
    // Every Claude Code hook payload carries transcript_path.  Whenever a
    // new one shows up, start tailing it so we can stream the assistant's
    // thinking + text blocks — the actual stream-of-consciousness.
    const tp = obs.payload?.transcript_path;
    if (tp && typeof tp === 'string') ensureTailing(tp);
    broadcast(obs);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}

// --- Transcript tailer ---------------------------------------------------
// Claude Code appends the running conversation to a JSONL file per session.
// Each assistant turn contains content blocks — `thinking` (my internal
// monologue) and `text` (what the user sees).  Both flow into the mandala.
const activeTails = new Map(); // path → { watcher, offset }
function ensureTailing(pathStr) {
  if (activeTails.has(pathStr)) return;
  fs.stat(pathStr, (err, st) => {
    if (err) return; // file not (yet) present
    // Start at the current end — replay is handled by /stream history.
    const state = { watcher: null, offset: st.size, busy: false };
    const pump = () => {
      if (state.busy) return;
      state.busy = true;
      fs.stat(pathStr, (err2, st2) => {
        if (err2 || st2.size <= state.offset) { state.busy = false; return; }
        const start = state.offset, end = st2.size;
        state.offset = end;
        const stream = fs.createReadStream(pathStr, { start, end });
        let buf = '';
        stream.on('data', c => { buf += c; });
        stream.on('end', () => {
          state.busy = false;
          for (const line of buf.split('\n')) {
            if (!line.trim()) continue;
            try { processTranscriptEntry(JSON.parse(line)); } catch {}
          }
        });
        stream.on('error', () => { state.busy = false; });
      });
    };
    state.watcher = fs.watch(pathStr, { persistent: false }, () => pump());
    activeTails.set(pathStr, state);
    console.log(`  tailing transcript: ${pathStr}`);
    pump();
  });
}

function processTranscriptEntry(rec) {
  // Assistant turns carry the blocks we care about.
  if (rec?.type !== 'assistant') return;
  const content = rec?.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking' && block.thinking) {
      // The actual internal monologue — stream of consciousness.
      broadcast({ type: 'assistant_thinking', text: String(block.thinking), ts: Date.now() });
    } else if (block.type === 'text' && block.text) {
      broadcast({ type: 'assistant_text', text: String(block.text), ts: Date.now() });
    }
  }
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

  // Accept both GET (word only, legacy) and POST { word, context }.
  let word = '', context = null;
  if (req.method === 'POST') {
    const body = await readBody(req, 200_000);
    try { const j = JSON.parse(body || '{}'); word = String(j.word || '').slice(0, 60); context = j.context || null; }
    catch { res.writeHead(400); res.end('{"error":"bad json"}'); return; }
  } else {
    const url = new URL(req.url, 'http://x');
    word = (url.searchParams.get('word') || '').slice(0, 60).trim();
  }
  if (!word) { res.writeHead(400); res.end('{"error":"no word"}'); return; }

  const client = await getAnthropic();
  if (!client) { res.writeHead(503); res.end('{"error":"no ANTHROPIC_API_KEY in env"}'); return; }

  const ctxBlock = context
    ? `Kontekst z sesji:
- narzędzia które wciągnęły ten koncept: ${(context.toolOrigins || []).join(', ') || '—'}
- sąsiednie koncepty: ${(context.neighbors || []).join(', ') || '—'}
- fragmenty ze strumienia:
${(context.excerpts || []).map(e => '  · ' + e).join('\n') || '  —'}`
    : `Brak kontekstu — pracujesz tylko z samym słowem.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content:
`Pojęcie "${word}" pojawiło się w czasie sesji rozwiązywania problemu technicznego.
${ctxBlock}

Zadanie: przełóż MECHANIZM który rozwiązał tu jakiś problem na wzorzec przydatny w REALNYM życiu poza kodem.
Przykład dobrej abstrakcji:
  koncept "auth token" → mechanizm: "krótkotrwały klucz zamiast długoterminowego hasła"
  → wzorzec: "ograniczaj zakres uprawnień w czasie i w przestrzeni"
  → zastosowanie: "gdy pożyczasz coś ważnego, ustal z góry termin zwrotu i konkretne użycie"

Odpowiedz WYŁĄCZNIE poprawnym JSON (bez markdown fence, bez komentarza) o strukturze:
{
  "mechanism": "jedno zdanie: co ten koncept faktycznie robi/rozwiązuje w tym kontekście technicznym",
  "pattern": "jedno zdanie: uogólniony wzorzec, oderwany od dziedziny",
  "application": ["2-3 konkretne zastosowania w życiu poza kodem", "każde 1 zdanie", "praktyczne, nie duchowe"]
}
Polski. Bez emoji. Bez fortune-cookie truizmów.` }],
    });
    const text = (msg.content?.[0]?.text || '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in response');
    const card = JSON.parse(m[0]);
    card.word = word; card.ts = Date.now();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(card));
  } catch (e) {
    console.log('skill-gen error:', e.message);
    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > maxBytes) { req.destroy(); reject(new Error('too large')); }});
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// --- Poster archive ------------------------------------------------------
// Accepts { name, png (base64), meta } and drops the PNG + a .json sidecar
// into ./posters/.  Also (re)generates ./posters/index.html gallery page.
function handlePublish(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 20_000_000) req.destroy(); });
  req.on('end', () => {
    try {
      const { name, png, meta } = JSON.parse(body);
      if (!name || !png) throw new Error('missing name/png');
      const dir = path.join(__dirname, 'posters');
      fs.mkdirSync(dir, { recursive: true });
      const safeName = name.replace(/[^a-z0-9._-]/gi, '_');
      const filePath = path.join(dir, safeName);
      fs.writeFileSync(filePath, Buffer.from(png, 'base64'));
      if (meta) fs.writeFileSync(filePath.replace(/\.png$/, '.json'), JSON.stringify(meta, null, 2));
      writeGalleryIndex(dir);
      console.log(`  poster saved: ${filePath}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: filePath, url: `/posters/${safeName}` }));
    } catch (e) {
      res.writeHead(400); res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  });
}

function writeGalleryIndex(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort().reverse();
  const rows = files.map(f => {
    const meta = tryReadJson(path.join(dir, f.replace(/\.png$/, '.json')));
    const iso = meta?.iso || '';
    const summary = meta?.concepts?.slice(0, 6).map(c => c.w).join(' · ') || '';
    return `<li><a href="${f}"><img src="${f}" loading="lazy"/><div><strong>${iso}</strong><span>${summary}</span></div></a></li>`;
  }).join('\n');
  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<title>thought · memory-posters</title>
<style>
:root { color-scheme: dark; }
body { margin:0; padding:60px 40px; background:#07040f; color:#e9e2ff;
       font-family: "JetBrains Mono", ui-monospace, monospace; }
h1 { font-family: "Fraunces", serif; font-style: italic; font-weight: 300;
     font-size: 56px; margin: 0 0 8px; color: #b58cff; }
p.sub { color:#9a8fbe; margin:0 0 40px; }
ul { list-style:none; padding:0; margin:0; display:grid;
     grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 24px; }
li a { display:block; color:inherit; text-decoration:none;
       background:#0d0820; border:1px solid rgba(123,77,255,0.15); border-radius:10px;
       overflow:hidden; transition: transform .15s, border-color .15s; }
li a:hover { transform: translateY(-3px); border-color: #b58cff; }
img { width:100%; height:auto; display:block; }
li div { padding: 12px 16px 16px; font-size: 11px; }
li strong { display:block; font-weight:500; color:#e9e2ff; margin-bottom:4px; }
li span { color:#9a8fbe; }
</style></head><body>
<h1>thought · memory-posters</h1>
<p class="sub">${files.length} archiwów. Każdy PNG zawiera ukryty JSON w chunku tEXt "thought-visualizer".</p>
<ul>${rows}</ul>
</body></html>`;
  fs.writeFileSync(path.join(dir, 'index.html'), html);
}
function tryReadJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// --- Router --------------------------------------------------------------
http.createServer((req, res) => {
  if (req.url.startsWith('/stream'))  return handleStream(req, res);
  if (req.url.startsWith('/observe')) return handleObserve(req, res);
  if (req.url.startsWith('/think'))   return handleThink(req, res);
  if (req.url.startsWith('/skill'))   return handleSkill(req, res);
  if (req.url.startsWith('/publish')) return handlePublish(req, res);
  return serveStatic(req, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  🧠  Thought Visualizer  →  http://localhost:${PORT}`);
  console.log(`      SSE:      http://localhost:${PORT}/stream`);
  console.log(`      Observe:  POST http://localhost:${PORT}/observe`);
  console.log(`      Open the visualizer at:  file://${path.join(__dirname, 'index.html')}\n`);
});
