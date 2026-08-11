#!/usr/bin/env node
// Reconstruct memory from a distributed session posted to
// lucdoro.design/thoughts/<session-id>/.  Given only the session id (or
// full URL), fetch index.json + all concept files, and print a
// memory.md-equivalent markdown to stdout.
//
// Usage:
//   node reconstruct.mjs <session-id-or-URL>
//   node reconstruct.mjs <session-id> word1 word2 ...     # only these
//   node reconstruct.mjs --local <session-id>              # read local ./posters/<id>/
//
// Typical flow when handed a screenshot in a future session:
//   1. Read the poster PNG visually, find the session URL printed on it
//      + note the concept labels you can see
//   2. Run: node reconstruct.mjs <session-id> concept1 concept2 ...
//   3. Pipe stdout into your context — you now know what the session was
//      about, decisions taken, tools used, and where each concept lived.

import fs from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: node reconstruct.mjs <session-id-or-url> [word ...]');
  console.error('       node reconstruct.mjs --local <session-id>');
  process.exit(2);
}

let useLocal = false;
if (argv[0] === '--local') { useLocal = true; argv.shift(); }

const target = argv.shift();
const wordFilter = argv;

let base;
if (useLocal) {
  base = path.resolve('posters', target);
} else if (target.startsWith('http')) {
  base = target.replace(/\/$/, '');
} else {
  base = `https://lucdoro.design/thoughts/${target}`;
}

async function loadJson(loc) {
  if (useLocal) return JSON.parse(await fs.readFile(loc, 'utf8'));
  const r = await fetch(loc);
  if (!r.ok) throw new Error(`${loc} → HTTP ${r.status}`);
  return r.json();
}

async function main() {
  const indexLoc = useLocal ? path.join(base, 'index.json') : `${base}/index.json`;
  process.stderr.write(`→ ${indexLoc}\n`);
  const index = await loadJson(indexLoc);
  process.stderr.write(`  session ${index.session} · ${index.date}\n`);
  process.stderr.write(`  ${index.top_concepts.length} concepts available\n\n`);

  const toFetch = wordFilter.length
    ? index.top_concepts.filter(c => wordFilter.includes(c.word))
    : index.top_concepts;

  const concepts = await Promise.all(toFetch.map(async c => {
    const loc = useLocal
      ? path.join(base, 'concepts', `${c.slug}.json`)
      : `${base}/concepts/${c.slug}.json`;
    try { return await loadJson(loc); }
    catch (e) { return { word: c.word, error: e.message }; }
  }));

  const ok = concepts.filter(c => !c.error);
  const fail = concepts.filter(c => c.error);

  // Emit memory.md-equivalent
  console.log('---');
  console.log(`name: reconstructed-${index.session}`);
  console.log(`session: ${index.session}`);
  console.log(`date: ${index.date}`);
  console.log(`source: ${useLocal ? indexLoc : `https://${base.replace(/^https?:\/\//, '')}`}`);
  console.log(`type: project`);
  console.log('---');
  console.log('');
  console.log(`# Reconstructed memory — ${index.session}`);
  console.log('');
  console.log(`Fetched **${ok.length}/${concepts.length}** concept files. ${fail.length ? `Missing: ${fail.map(f => f.word).join(', ')}` : ''}`);
  console.log('');
  console.log('## Session stats');
  console.log('');
  for (const [k, v] of Object.entries(index.stats || {})) console.log(`- **${k}**: ${v}`);
  if (index.tools?.length) console.log(`- **tools seen**: ${[...new Set(index.tools.map(t => String(t).split(' ')[0]))].slice(0, 12).join(', ')}`);
  console.log('');
  console.log('## Concepts');
  console.log('');
  for (const c of ok.sort((a, b) => (b.energy || 0) - (a.energy || 0))) {
    console.log(`### ${c.word}`);
    console.log('');
    console.log(`- energy **${(c.energy || 0).toFixed(2)}** · mentioned **${c.mentions_count}×**`);
    if (c.related_concepts?.length) {
      console.log(`- related: ${c.related_concepts.slice(0, 8).join(', ')}`);
    }
    if (c.first_mention) console.log(`- first: _"${c.first_mention.replace(/"/g, "'")}"_`);
    if (c.excerpts?.length) {
      console.log(`- excerpts:`);
      for (const e of c.excerpts.slice(-3)) {
        console.log(`  - [${e.kind}] ${e.text.replace(/\n/g, ' ').slice(0, 240)}`);
      }
    }
    console.log('');
  }
  if (fail.length) {
    console.log('## Failed concept fetches');
    console.log('');
    for (const f of fail) console.log(`- ${f.word}: ${f.error}`);
  }
}

main().catch(err => { console.error('reconstruct failed:', err.message); process.exit(1); });
