---
name: Narrative Mode for Thought Visualizer
date: 2026-08-11
status: designed (implementation pending)
supersedes-partial: SIMULATE isolation brainstorm (folded into mode-toggle)
---

# Narrative Mode

A second, mutually-exclusive view mode for the thought visualizer. Where
"graph" mode is the current 4D physics mandala, "narrative" mode is a
DeepSeek-style live chat pane plus a live distilled memory.md sidebar —
optimized for reading the session and for producing a poster that carries
memory equivalent to a hand-curated `memory.md` file.

## Why this exists

The mandala looks beautiful but is a bad reading surface:
- concepts drift, so you can't find a specific one later
- chronology is destroyed by force-directed physics
- posters exported from it show *what happened* (events) but not *what
  was decided* (memory) — reading them isn't equivalent to reading a
  memory.md
- keeping it running as a backdrop under narrative UI still costs full
  physics + O(N²) repulsion + gradient halos per frame

Narrative mode is text-first, chronological, information-dense, sanitized,
and produces a poster whose visible content IS the memory doc.

## Non-goals

- Not replacing graph mode. Both live in the app; user picks.
- Not rendering the mandala as backdrop of narrative. Zero canvas load
  in narrative mode.
- Not implementing session picker or website scroll-bg — those are open
  loops tracked separately.

## Structure

### Mode toggle

Replaces the current `auto-observe | demo` mode pill.

```
[ graph ] [ narrative ]      (top-center, mutually exclusive)
```

`graph` = current 4D mandala with physics, auto-observe/demo pipeline
retained internally.

`narrative` = layout below. Canvas element is hidden and the render loop
short-circuits (returns before physics + draw). Zero GPU, zero fizyki.

### Narrative layout — two columns, 2:1

```
┌──────────────────────────────────┬────────────────────┐
│ STREAM (DeepSeek-style)          │ DESTYLAT (memory.md│
│                                  │  equivalent)       │
│  ─── chapter (user prompt) ───   │ ---                │
│                                  │ name: sesja-...    │
│  ┌─ reasoning ▾ ─────────────┐  │ type: project      │
│  │ mint italic, muted body   │  │ ---                │
│  └───────────────────────────┘  │                    │
│                                  │ ## Decyzje         │
│  amber Fraunces body of the      │ - ...              │
│  response with ⟨concept⟩ pills   │   Why: ...         │
│  inline. cursor █ at write pos.  │                    │
│                                  │ ## Reguły          │
│  [◆ Bash] [◆ Edit] tool chips    │ ## Otwarte pętle   │
│                                  │ ## Referencje      │
│  ─── next chapter ───────────    │                    │
└──────────────────────────────────┴────────────────────┘
```

### Left column — DeepSeek-style stream

**Source**: same observation pipeline (hook events + transcript tailer)
that graph mode uses. Only the rendering changes.

**Turn boundaries**: each `user_prompt` observation opens a new "chapter"
— a horizontal separator with a centered timestamp and the prompt text
rendered in Fraunces italic 15px, gold `#ffe08c`.

**Reasoning blocks**: each `assistant_thinking` block renders in a mint
bordered container. Header: monospace label `reasoning · Xt · ▾` with a
collapse arrow. Body: Fraunces italic 11px, color `#a8f0d0`, indent.
Default state: expanded. Auto-collapse when the *next* turn's user prompt
arrives (previous reasoning has been "read past").

**Response blocks**: each `assistant_text` block renders as body text,
Fraunces italic 13px, amber `#ffd28c`. Bold spans use `#fff3d6`.

**Typewriter reveal**: newly-arrived thinking/text blocks reveal
character-by-character at ~40 chars/sec. Cursor `█` blinks at the write
position while revealing. Instant-reveal is available on demand (click
to skip).

**Concept pills inline**: any word whose sanitized form matches a known
concept (i.e. exists in the neuron registry) is wrapped in a span with a
dotted-underline border, colored per hue. Hover shows count + first/last
time. Click filters the stream to only turns mentioning it.

**Tool calls**: `pre_tool` observations render as inline chips
between paragraphs — small violet pills with the tool name + short arg
summary. Click opens an overlay with the full input/output.

**Auto-scroll**: pinned to bottom while user is at bottom. If user scrolls
up ≥ 80px from bottom, auto-scroll suspends until they return.

### Right column — Live destylat (memory.md equivalent)

**Content**: markdown formatted as a memory-file body:
- frontmatter header (`name`, `type`, `date`)
- `## Decyzje` — decisions taken, each with `Why:`
- `## Reguły` — rules to apply, each with `Why:` and `How to apply:`
- `## Otwarte pętle` — unresolved work
- `## Referencje` — URLs, file paths, external artifacts

**Rendering**: JetBrains Mono 10px for structure, `#e9e2ff` body,
`#b58cff` H5 in Fraunces italic 12px, `#7effc6` inline code, `#9a8fbe`
em for `Why:`/`How to apply:` labels.

**Update source**: server endpoint `POST /distill` accepts the current
sanitized session snapshot (concepts, recent stream, tool origin map)
and returns structured markdown.

**Update cadence**: called every 25 new observations (debounced 3s),
plus on `→ plakat` click. Frontend caches the last result in memory so
poster export uses it directly.

**Model**: `claude-haiku-4-5-20251001` by default (cost ~$0.0007 per
tick). Configurable to `claude-sonnet-4-6` via env var
`DISTILL_MODEL` when depth matters more than budget.

**Fallback (no API key)**: renders shallow MD from local data —
frontmatter + concept list + tool usage counts + last N stream excerpts,
no decisions/rules/why. Right-column badge shows "distill unavailable —
set ANTHROPIC_API_KEY".

### Poster export from narrative mode

Layout: 2400 × 3000 portrait, two columns of visible content:
```
[ header: top concepts as title, Fraunces italic ]
[ meta: claude · opus 4.7 · timestamp ]

┌───── LEFT (60%) ─────────┐  ┌── RIGHT (40%) ──┐
│ narrative excerpts,      │  │ full destylat MD│
│ Fraunces italic,         │  │ JetBrains Mono, │
│ concept pills preserved  │  │ headings colored│
└──────────────────────────┘  └─────────────────┘

[ memory-sigil · decode: node decode.mjs --md ]
```

The right column is **visually legible** as a memory.md entry — you can
photograph the poster, load it with `Read` in a future Claude session,
and read the memory content directly. No decoder required.

**tEXt chunk**: PNG carries both structured JSON (as before, sanitized)
AND a new `memory_md` field holding the raw markdown string.

**Sidecar** (opt-in, `?persist=1` on save or env `POSTER_AUTOPERSIST=1`):
also writes `~/.claude/projects/-Users-lucdoro/memory/session-<iso>.md`
so a future session's memory bootstrap loads it automatically.

## Data flow

```
hook / transcript → /observe → SSE broadcast → both modes
  ↓                                             ├── graph mode:
  transcript tailer                             │   neurons + physics + canvas
  extracts thinking + text                      │
                                                └── narrative mode:
  every 25 events (debounced):                      DeepSeek stream + distill
    POST /distill { sanitized snapshot }                       ↑
    ← markdown                                                 │
    frontend caches, renders in right col ─────────────────────┘
```

## Sanitize — non-negotiable

All text passing through:
- narrative rendering
- concept pill generation
- distill prompt input
- poster tEXt chunk
- sidecar MD file

...is passed through `sanitize(text, strict=true)` first. Already
implemented — no new work here, just enforce that no new code path
skips it.

## Trade-offs accepted

| Loss | Justification |
|---|---|
| No live mandala in narrative | Backdrop = CPU/GPU cost with negligible aesthetic gain |
| No 4D dive/rotate in narrative | Nothing to dive into — text scrolls linearly |
| Poster no longer looks like a mandala portrait | Poster now equivalent to memory.md, which is the primary requirement |
| Typewriter reveal is post-hoc (transcript is written per-turn) | Can't do true streaming without API-level interception; typewriter at 40cps preserves the DeepSeek aesthetic |

## Open loops (deferred)

- **Session picker** — multi-transcript enumeration + per-session view.
  Blocks: needs UI for switching, needs multi-session separation in
  physics/stream state.
- **lucdoro.design scroll-driven mandala background** — port a stripped
  canvas as a scroll-progress driven ambient layer on the portfolio.
- **SIMULATE isolation** — the original brainstorm topic. Superseded by
  the mode-toggle: SIMULATE remains as a source *within* graph mode (for
  GitHub Pages demos). If further isolation is wanted later, becomes a
  third top-level toggle option `[ graph ] [ narrative ] [ simulate ]`.

## Effort estimate

- Mode-toggle infrastructure (hide canvas, short-circuit render): 1h
- Narrative layout HTML/CSS: 1h
- DeepSeek-style rendering (chapters, reasoning box, response, chips): 2h
- Typewriter reveal + concept pill inline highlight: 2h
- Auto-scroll behavior + scroll-lock detection: 1h
- `/distill` endpoint + prompt tuning: 2h
- Right-column live rendering + caching: 1h
- Poster redesign (2-column with visible distill): 2h
- `memory_md` in tEXt + `decode.mjs --md` mode: 1h
- Sidecar MD writer (opt-in): 30min
- **Total: ~13.5h in-file, no new dependencies**

## Verification

- All existing sanitize tests still pass; add: distill prompt input is
  sanitized before send.
- Narrative mode: canvas element has `display: none`, `stepPhysics` +
  `draw` early-return, FPS meter reads 0 physics ticks / sec.
- Poster: `decode.mjs --md poster.png` prints valid markdown parseable
  as a memory-file body.
- Sidecar written to memory/ dir is loaded by memory bootstrap on next
  session start (integration test in a scratch project).

## Extension — Metro Map paradigm (added 2026-08-11)

An additional visual paradigm using the Tokyo/London subway map metaphor.
Better than the mandala for **structural readability**: at one glance you
see themes as lines, decisions as stations, and cross-cutting concerns as
interchanges.

### Mapping

| Metro element | Session equivalent |
|---|---|
| Line (unique color) | Thematic cluster of co-occurring concepts |
| Station | Concept or decision node |
| Interchange | Concept appearing on 2+ lines (bridges themes) |
| Line direction | Chronological order (first→last mention) |
| Terminus | Open loop / unresolved thread |
| Legend | Line name + 1-sentence narrative summary |

### Rendering

- Orthogonal Beck-style layout (lines run horizontal/vertical with 45°
  turns), background dark, lines in high-saturation hues
- Station markers: filled circles (~8px); interchanges are doubled outer
  ring (~14px) in white
- Labels in a clean sans (Manrope / Inter), 11px, slight rotation on
  vertical lines
- Legend bottom-strip: `━━ line-name · X stations · "1-sentence"`

### Where it fits in the app

**Poster format** (primary use, recommended): user chooses between
"narrative poster" (2-col Fraunces + destylat) and "metro poster" (full
map + legend footer) at export time. Both carry the same tEXt chunk and
memory_md, differ only in visible presentation.

**Optional third mode** (secondary): `[ graph ] [ narrative ] [ metro ]`
top-level toggle for in-app exploration. Metro mode shows the layout
live, updating as new stations/lines emerge from clustering.

### Layout challenge

Metro-map layout is NP-hard in the general case. Pragmatic prototype
approach:
1. Cluster concepts into lines via synapse-strength community detection
   (or AI clustering if API key available — one Sonnet call per session)
2. Each line: sort stations by first-mention time
3. Assign lines to horizontal tracks (top-to-bottom by size)
4. Detect interchanges → introduce 45° bends to make them coincide
5. Heuristic-only, no guarantee of aesthetic optimum, but recognizable

### Effort estimate (metro addition)

- Concept clustering (co-occurrence or Sonnet cluster call): 2h
- Layout algorithm (heuristic orthogonal): 4h
- Render (canvas or SVG): 2h
- Poster variant integration: 2h
- **Total: ~10h on top of narrative implementation**

### Priority

Ship narrative mode first (as spec'd above). Metro paradigm is deferred
until narrative is validated. When implementing, add as a poster format
option first (higher value per hour), then optionally as third mode.

## Extension — Circuit Flow paradigm (added 2026-08-11)

An additional visual paradigm inspired by cyberpunk/matrix "circuit board
with flowing code" imagery. Where metro-map is a static schematic and
mandala is organic swirl, circuit-flow is **orthogonal grid with moving
light packets and inline code fragments streaming along traces**.

### Mapping

| Circuit element | Session equivalent |
|---|---|
| Neon trace | Information flow path: user prompt → thinking → tool → response |
| Junction (glowing) | Tool call or decision point |
| Data packet (impulse along trace) | Token or concept in motion |
| Code text along trace | Actual content (thinking snippet, tool input, response fragment) |
| Isometric grid | Time axis × concept axis, depth = perspective into past |
| Reflection below | Optional "sanitized shadow" — hint of what was redacted, without content |

### Rendering

- Black background, high-saturation neon palette (green primary as
  reference, or per-user hue theme)
- Isometric 30° perspective grid, orthogonal traces at 90° / 45° angles
- Junctions as small bright squares (~6px filled with 12px halo)
- Data packets as short bright segments traveling along traces at
  ~120px/sec, tail fade
- Code fragments (2-5 words) render inline along the trace, oriented
  with the trace direction (rotated text)
- Depth fog: farther-back traces dim exponentially, giving infinite-grid
  feel
- Optional bottom reflection layer at ~15% opacity, offset+skewed

### Where it fits

Same options as metro map:
- Poster format #3 (alongside narrative + metro)
- Fourth top-level mode `[ graph ] [ narrative ] [ metro ] [ circuit ]`

### Layout algorithm

Simpler than metro (no NP-hard requirement — traces can freely cross):
1. Assign each turn to a horizontal band on the isometric plane
2. Each event within a turn extends the trace toward the next event
3. Tool calls branch off the main trace as short spurs to a junction
4. Concepts appear as labels floating above their moment of introduction
5. Data packets spawn per new event, travel toward the next junction

Recognizable within 2-3h of layout + render work.

### Effort estimate (circuit addition)

- Isometric projection helpers + grid render: 2h
- Trace generation from event stream: 2h
- Data packet animation: 1h
- Text-along-trace with rotation: 2h
- Poster variant: 2h
- **Total: ~9h**

### Priority

Same as metro: ship narrative first, then metro poster, then circuit as
third option. Circuit is the most aesthetically striking and works best
as a **screensaver / ambient display** — a good candidate for the
lucdoro.design background layer (which is a separate open loop).

## Rollout

Ship behind a query flag first: `?mode=narrative` or a hidden toggle
click. Once verified on a real session, promote the toggle to the main
UI. Existing users default to `graph` until they switch (their choice
persists in localStorage).
