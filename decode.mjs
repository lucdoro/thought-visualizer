#!/usr/bin/env node
// Extracts the "thought-visualizer" tEXt chunk from a memory-poster PNG
// and prints the embedded JSON.  Usage:
//   node decode.mjs poster.png            → pretty-printed JSON to stdout
//   node decode.mjs poster.png --summary  → topic + top concepts only
//   node decode.mjs poster.png --stream   → last stream entries as terminal log

import fs from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node decode.mjs poster.png [--summary|--stream]'); process.exit(2); }
const mode = process.argv[3] || '';
const buf = fs.readFileSync(file);

if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)) {
  console.error('not a PNG'); process.exit(2);
}

let off = 8;
let found = null;
while (off < buf.length - 12) {
  const len = buf.readUInt32BE(off);
  const type = buf.slice(off + 4, off + 8).toString('ascii');
  if (type === 'tEXt') {
    const data = buf.slice(off + 8, off + 8 + len);
    const nulIdx = data.indexOf(0);
    const key = data.slice(0, nulIdx).toString('utf8');
    const value = data.slice(nulIdx + 1).toString('utf8');
    if (key === 'thought-visualizer') { found = value; break; }
  }
  if (type === 'IEND') break;
  off += 8 + len + 4;
}
if (!found) { console.error('no thought-visualizer chunk found'); process.exit(1); }

const meta = JSON.parse(found);

if (mode === '--summary') {
  console.log('date  :', meta.iso);
  console.log('stats :', meta.session);
  console.log('topic :', (meta.concepts || []).slice(0, 8).map(c => c.w).join(' · '));
  console.log('tools :', [...new Set((meta.tools || []).map(t => t.split(' ')[0]))].join(', '));
} else if (mode === '--stream') {
  const color = { thinking: '\x1b[92m', text: '\x1b[93m', tool: '\x1b[95m',
                  result: '\x1b[90m', user: '\x1b[33m', system: '\x1b[36m' };
  for (const e of (meta.stream || [])) {
    const c = color[e.k] || '';
    process.stdout.write(`${c}[${(e.k || '?').padEnd(8)}]\x1b[0m ${e.t}\n`);
  }
} else {
  console.log(JSON.stringify(meta, null, 2));
}
