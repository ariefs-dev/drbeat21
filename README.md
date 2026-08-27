# Dr Beat 21

A browser metronome modelled on the Boss DB-90 *Dr. Beat* — subdivision mixing,
accent patterns, the three Rhythm Coach practice modes, memory slots and MIDI
clock out. No build step, no dependencies, no samples: every click is synthesised.

## Running it

```bash
python3 -m http.server 8321
# then open http://localhost:8321
```

Serve it rather than opening `index.html` from disk. Browsers only grant
microphone access on `https://` or `localhost`, and Time Check needs the mic.
Everything else works from a `file://` URL.

## What it does

**Tempo** — 30–250 BPM by slider, ±1/±10 buttons, quick-pick chips, or tap tempo
(averages your last six taps and forgets the history if you pause).

**Beat** — 0–9 beats per bar; note value 2/4/8/16. Each beat cycles through
accented → normal → silent, so 3-3-2 groupings and backbeat-only patterns are
just click-click-click. Six preset patterns are built in.

**Note** — five subdivision layers (quarter, eighth, triplet, sixteenth, shuffle)
that stack on top of the beat, each with its own level fader. Turning the quarter
layer off leaves the subdivision grid complete rather than punching a hole in it.

**Sound** — six synthesised voices, plus a held reference tone tunable from
A415 to A466 across all twelve pitches.

**Rhythm Coach**

| Mode | What it does |
|---|---|
| Quiet Count | Drops the click for whole bars so you keep your own time. Optionally widens the silence by one bar per cycle, up to a cap. |
| Gradual Up/Down | Steps the tempo by *X* BPM every *N* bars between two tempi, optionally reversing at the target and repeating. |
| Time Check | Listens on the mic, matches each hit to the nearest grid point, and reports accuracy, average error and early/late bias. |

**Memory** — named setups in `localStorage`, with JSON export/import. The current
setup is also restored automatically next time you open the page.

**MIDI clock out** — 24 PPQN clock plus start/stop, so a drum machine or DAW
follows this tempo. Chrome and Edge only; Safari and Firefox have no Web MIDI.

**Keys** — `Space` start/stop · `T` tap · `↑`/`↓` ±1 BPM · `Shift`+`↑`/`↓` ±10 BPM.

## How the timing works

The part that decides whether a metronome is usable is scheduling, and
`setTimeout`/`setInterval` are far too jittery to drive audio directly. Instead a
25 ms interval acts only as a *ticker*: on each wake-up it queues every grid
position falling within the next 120 ms directly onto the `AudioContext` clock,
which is sample-accurate. Timer jitter therefore changes how early events are
queued, never when they sound. (Chris Wilson, *A Tale of Two Clocks*.)

The grid is **12 ticks per beat**, because 12 divides evenly by 1, 2, 3 and 4 —
so beats, eighths, triplets and sixteenths all land on integer ticks and stay
phase-locked instead of drifting against each other.

Two consequences worth knowing:

- **Tempo changes never retime queued beats.** Only ticks scheduled after the
  change use the new spacing, so the beat under the playhead cannot shift.
- **The LEDs run off the audio clock**, not off the moment an event was queued —
  otherwise they would flash up to 120 ms early.

Time Check detects onsets in an `AudioWorklet` rather than from
`requestAnimationFrame`: a frame loop would quantise every measurement to the
~16 ms frame boundary, which is the same order as the error being measured. The
worklet timestamps the sample that crossed the threshold instead.

| File | Role |
|---|---|
| `js/engine.js` | Scheduler, grid, accents, subdivision layers |
| `js/voices.js` | Synthesised click voices |
| `js/coach.js`  | The three practice modes and onset detection |
| `js/midi.js`   | MIDI clock output |
| `js/presets.js`| Memory slots |
| `js/ui.js`     | DOM wiring |

## Tests

```bash
node test/engine.test.js          # 26 timing and coach tests, no browser needed
```

The engine tests drive the scheduler from a fake `AudioContext` clock, so every
assertion is exact and nothing sleeps: beat spacing, note values, accent cycling,
subdivision placement, mid-run tempo changes, and all three coach modes.

Voice rendering is tested in a browser, since it needs real Web Audio:

```bash
python3 -m http.server 8321
# open http://localhost:8321/test/voices.test.html
```

Each voice is rendered through an `OfflineAudioContext` and checked for actual
output, attack timing, decay to silence, headroom, and strict accent > beat > sub
level ordering.

## Install it as an app

The page is a PWA: a web app manifest, a service worker and icons ship with it,
so browsers offer to install it and it opens in its own window without browser
chrome. Once loaded it **works with no network at all** — which is the point,
because rehearsal rooms are where the wifi is worst.

- **Chrome / Edge / Android** — an *Install Dr Beat 21* button appears at the
  bottom of the page when the browser judges it installable.
- **iOS Safari** — Share → *Add to Home Screen*. Safari never fires the install
  event, so there is no button to offer.

The service worker precaches the app shell on first load and serves it
cache-first afterwards. Bump `CACHE` in `sw.js` when the shell changes; the old
cache is dropped on activation. Presets are unaffected either way — they live in
`localStorage` and never enter the cache.

Every path in `manifest.webmanifest` and `sw.js` is relative, so the app works
both at a domain root and under a project-site subpath.

## Single-file build

```bash
python3 tools/build-single-file.py     # -> dist/drbeat21.html
```

Inlines the CSS and JS into one self-contained HTML file you can open from disk
or hand to someone as a single attachment. It is generated from `css/` and `js/`,
so there is no second copy of the app to keep in sync. `--artifact` emits the
same page without the document skeleton, for hosts that supply their own.

The hosted build cannot start a download on its own — the viewer mediates saves —
so preset export asks the host first and falls back to a direct download when the
page owns its tab.

## Known limitations

- **No spoken count-in.** The DB-90 counts "1-2-3-4" aloud; `speechSynthesis`
  has variable latency and would not land on the beat, so it is left out rather
  than done badly.
- **No drum patterns.** The DB-90's 50 rhythm patterns need samples; accent
  patterns cover the same practice ground here.
- **Time Check needs calibration.** The mic path adds latency the browser will
  not report reliably. Play along with a sound the mic can hear clearly, watch
  the bias figure, and set the latency offset to cancel it.
