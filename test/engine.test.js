/* Deterministic tests for the timing engine and the rhythm coach.
 *
 * The scheduler is driven by a fake AudioContext clock, so every assertion is
 * exact — no real audio device, no sleeping, no flakiness.
 *
 *   node test/engine.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ── Load the browser modules into a sandbox ── */

const sandbox = {
  window: {},
  performance: { now: () => 0 },
  setInterval: () => 1,
  clearInterval: () => {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  Blob: function () {},
  URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  navigator: {}
};
sandbox.self = sandbox;
vm.createContext(sandbox);

for (const file of ['voices.js', 'engine.js', 'coach.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
  vm.runInContext(src, sandbox, { filename: file });
}
const DB = sandbox.window.DrBeat;

/* ── Test harness ── */

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ name, message: e.message });
  }
}

function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function near(actual, expected, tol, what) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${what}: expected ${expected} ±${tol}, got ${actual}`);
  }
}

/* ── A rig that records every sound the scheduler would produce ── */

function makeRig(configure) {
  const events = [];
  const engine = new DB.Engine();

  engine.ctx = { currentTime: 0, state: 'running', resume() {} };
  engine.masterGain = {};

  // Capture scheduled hits instead of building audio nodes.
  DB.Voices.play = (ctx, dest, time, level, voice, gain) => {
    if (gain <= 0.0005) return;
    events.push({ time, level, gain });
  };

  if (configure) configure(engine);
  engine.start();
  return { engine, events };
}

// Advance the fake clock in small steps, letting the scheduler queue as it goes.
function run(engine, seconds, step = 0.02) {
  const end = engine.ctx.currentTime + seconds;
  while (engine.ctx.currentTime < end) {
    engine.ctx.currentTime = Math.min(end, engine.ctx.currentTime + step);
    engine._scheduler();
  }
}

const beats = (events) => events.filter((e) => e.level !== 'sub').map((e) => e.time);
const subs = (events) => events.filter((e) => e.level === 'sub').map((e) => e.time);

/* ── Timing ── */

check('120 BPM in 4/4 places beats exactly 0.5 s apart', () => {
  const { engine, events } = makeRig((e) => { e.setBpm(120); e.setBeatsPerMeasure(4); });
  run(engine, 4);
  const t = beats(events);
  if (t.length < 8) throw new Error(`expected at least 8 beats, got ${t.length}`);
  for (let i = 1; i < t.length; i++) {
    near(t[i] - t[i - 1], 0.5, 1e-9, `gap ${i}`);
  }
});

check('tempo maps linearly: 90 BPM gives a 0.6667 s beat', () => {
  const { engine, events } = makeRig((e) => { e.setBpm(90); });
  run(engine, 3);
  const t = beats(events);
  near(t[1] - t[0], 60 / 90, 1e-9, 'beat length');
});

check('note value 8 halves the click interval', () => {
  const { engine, events } = makeRig((e) => {
    e.setBpm(120); e.setBeatsPerMeasure(6); e.beatUnit = 8;
  });
  run(engine, 3);
  const t = beats(events);
  near(t[1] - t[0], 0.25, 1e-9, 'eighth-note beat length');
});

check('accents follow the pattern and repeat every bar', () => {
  const { engine, events } = makeRig((e) => { e.setBpm(120); e.setBeatsPerMeasure(4); });
  run(engine, 4.2);
  const levels = events.filter((e) => e.level !== 'sub').map((e) => e.level);
  eq(levels.slice(0, 8).join(','), 'accent,beat,beat,beat,accent,beat,beat,beat', 'accent cycle');
});

check('a silenced beat produces no sound at all', () => {
  const { engine, events } = makeRig((e) => {
    e.setBpm(120); e.setBeatsPerMeasure(4);
    e.accents = [2, 1, 0, 1];           // beat 3 muted
  });
  run(engine, 2.1);
  const t = beats(events);
  // Beats land at 0.06, 0.56, (1.06 silent), 1.56, ...
  const rel = t.map((x) => Math.round((x - t[0]) * 1000) / 1000);
  if (rel.includes(1.0)) throw new Error('muted beat still sounded');
  eq(rel.slice(0, 3).join(','), '0,0.5,1.5', 'beat placement around the silent beat');
});

/* ── Subdivision layers ── */

check('eighth layer adds one hit halfway through each beat', () => {
  const { engine, events } = makeRig((e) => {
    e.setBpm(120); e.setBeatsPerMeasure(4);
    e.layers.eighth.on = true;
  });
  run(engine, 2);
  const b = beats(events), s = subs(events);
  eq(s.length, b.length - (b.length > s.length ? 1 : 0) || s.length, 'sub count sanity');
  near(s[0] - b[0], 0.25, 1e-9, 'offbeat position');
});

check('triplet layer puts two extra hits per beat, evenly spaced', () => {
  const { engine, events } = makeRig((e) => {
    e.setBpm(120); e.layers.triplet.on = true;
  });
  run(engine, 1.6);
  const b = beats(events), s = subs(events);
  const first = s.filter((t) => t > b[0] && t < b[1]);
  eq(first.length, 2, 'triplet subdivisions inside one beat');
  near(first[0] - b[0], 0.5 / 3, 1e-9, 'first triplet');
  near(first[1] - b[0], 1.0 / 3, 1e-9, 'second triplet');
});

check('sixteenth layer puts three extra hits per beat', () => {
  const { engine, events } = makeRig((e) => {
    e.setBpm(120); e.layers.sixteenth.on = true;
  });
  run(engine, 1.6);
  const b = beats(events), s = subs(events);
  const first = s.filter((t) => t > b[0] && t < b[1]);
  eq(first.length, 3, 'sixteenth subdivisions inside one beat');
  near(first[0] - b[0], 0.125, 1e-9, 'first sixteenth');
});

check('shuffle places the offbeat two thirds through the beat', () => {
  const { engine, events } = makeRig((e) => {
    e.setBpm(120); e.layers.shuffle.on = true;
  });
  run(engine, 1.6);
  const b = beats(events), s = subs(events);
  const first = s.filter((t) => t > b[0] && t < b[1]);
  eq(first.length, 1, 'one swung offbeat per beat');
  near(first[0] - b[0], 0.5 * (8 / 12), 1e-9, 'swing position');
});

check('turning the quarter layer off leaves the subdivision grid complete', () => {
  const { engine, events } = makeRig((e) => {
    e.setBpm(120);
    e.layers.quarter.on = false;
    e.layers.eighth.on = true;
  });
  run(engine, 2);
  eq(beats(events).length, 0, 'no beat clicks');
  const s = subs(events);
  for (let i = 1; i < s.length; i++) near(s[i] - s[i - 1], 0.25, 1e-9, `even eighths ${i}`);
});

check('layers at zero volume are not scheduled', () => {
  const { engine, events } = makeRig((e) => {
    e.setBpm(120); e.layers.eighth.on = true; e.layers.eighth.vol = 0;
  });
  run(engine, 2);
  eq(subs(events).length, 0, 'silent layer produced hits');
});

/* ── Tempo changes ── */

check('a mid-run tempo change does not retime already-queued beats', () => {
  const { engine, events } = makeRig((e) => { e.setBpm(120); });
  run(engine, 1);
  const before = beats(events).slice();
  engine.setBpm(240);
  run(engine, 1);
  const after = beats(events);
  // Everything scheduled before the change must be byte-identical afterwards.
  eq(after.slice(0, before.length).join(','), before.join(','), 'previously queued beats moved');
  const tail = after.slice(-3);
  near(tail[2] - tail[1], 0.25, 1e-9, 'new tempo spacing');
});

check('tempo is clamped to the 30–250 BPM range', () => {
  const e = new DB.Engine();
  e.setBpm(5);   eq(e.bpm, 30, 'lower clamp');
  e.setBpm(9999); eq(e.bpm, 250, 'upper clamp');
});

/* ── Meter handling ── */

check('setBeatsPerMeasure grows and shrinks the accent pattern', () => {
  const e = new DB.Engine();
  e.setBeatsPerMeasure(7);
  eq(e.accents.length, 7, 'grown length');
  eq(e.accents[0], 2, 'downbeat stays accented');
  e.setBeatsPerMeasure(3);
  eq(e.accents.length, 3, 'shrunk length');
});

check('0 beats per bar means a steady unaccented click', () => {
  const { engine, events } = makeRig((e) => { e.setBpm(120); e.setBeatsPerMeasure(0); });
  run(engine, 2.2);
  const levels = events.map((e) => e.level);
  if (levels.includes('accent')) throw new Error('accent produced with no bar length');
  eq(levels.length > 3, true, 'clicks still produced');
});

/* ── Rhythm coach: quiet count ── */

check('quiet count alternates sounding and silent bars', () => {
  const { engine, events } = makeRig((e) => {
    e.setBpm(240);
    e.setBeatsPerMeasure(4);
    const coach = new DB.Coach(e);
    coach.setMode('quiet');
    coach.quiet.playBars = 1;
    coach.quiet.muteBars = 1;
    e.onBarScheduled = (barIndex) => coach.onBar(barIndex);
  });

  run(engine, 4);
  const t = beats(events);
  // One bar at 240 BPM is 1 s. Bar 1 sounds, bar 2 is silent, and so on.
  const barOf = (time) => Math.floor((time - t[0] + 1e-6) / 1.0);
  const soundingBars = new Set(t.map(barOf));
  eq(soundingBars.has(0), true, 'first bar should sound');
  eq(soundingBars.has(1), false, 'second bar should be silent');
  eq(soundingBars.has(2), true, 'third bar should sound');
});

check('quiet count can widen the silence one bar per cycle', () => {
  const engine = new DB.Engine();
  engine.ctx = { currentTime: 0, state: 'running', resume() {} };
  const coach = new DB.Coach(engine);
  coach.setMode('quiet');
  coach.quiet.playBars = 1;
  coach.quiet.muteBars = 1;
  coach.quiet.gradual = true;
  coach.quiet.maxMute = 3;

  // Cycle one covers bars 0-1 (1 sounding + 1 silent); reaching bar 2 closes it.
  coach.onBar(0); coach.onBar(1);
  eq(coach.quiet.muteBars, 1, 'still mid-cycle');
  coach.onBar(2);
  eq(coach.quiet.muteBars, 2, 'silence widened once the cycle closed');
  eq(coach.quiet.cycles, 1, 'one cycle counted');

  // Cycle two now spans bars 2-4 (1 sounding + 2 silent).
  coach.onBar(3); coach.onBar(4); coach.onBar(5);
  eq(coach.quiet.muteBars, 3, 'silence widened again');
  for (let i = 6; i < 30; i++) coach.onBar(i);
  eq(coach.quiet.muteBars, 3, 'widening stopped at the cap');
});

check('quiet count keeps its phase even if a bar callback is missed', () => {
  const engine = new DB.Engine();
  engine.ctx = { currentTime: 0, state: 'running', resume() {} };
  const coach = new DB.Coach(engine);
  coach.setMode('quiet');
  coach.quiet.playBars = 2;
  coach.quiet.muteBars = 2;

  coach.onBar(0); eq(engine.muted, false, 'bar 0 sounds');
  coach.onBar(1); eq(engine.muted, false, 'bar 1 sounds');
  // Bar 2's callback never arrives — the phase must still be right at bar 3.
  coach.onBar(3); eq(engine.muted, true, 'bar 3 is silent despite the gap');
  coach.onBar(4); eq(engine.muted, false, 'the next cycle starts on time');
});

/* ── Rhythm coach: gradual up/down ── */

check('gradual mode steps the tempo up every N bars', () => {
  const engine = new DB.Engine();
  engine.ctx = { currentTime: 0, state: 'running', resume() {} };
  const coach = new DB.Coach(engine);
  coach.gradual = { startBpm: 100, targetBpm: 120, stepBpm: 5, everyBars: 2, loop: false, done: false };
  coach.setMode('gradual');
  eq(engine.bpm, 100, 'starts at the start tempo');

  coach.onBar(1); eq(engine.bpm, 100, 'no change on an off-cycle bar');
  coach.onBar(2); eq(engine.bpm, 105, 'first step');
  coach.onBar(4); eq(engine.bpm, 110, 'second step');
  coach.onBar(6); eq(engine.bpm, 115, 'third step');
  coach.onBar(8); eq(engine.bpm, 120, 'target reached');
  eq(coach.gradual.done, true, 'marked done');
  coach.onBar(10); eq(engine.bpm, 120, 'stays at the target');
});

check('gradual mode counts down when the target is lower', () => {
  const engine = new DB.Engine();
  engine.ctx = { currentTime: 0, state: 'running', resume() {} };
  const coach = new DB.Coach(engine);
  coach.gradual = { startBpm: 120, targetBpm: 100, stepBpm: 10, everyBars: 1, loop: false, done: false };
  coach.setMode('gradual');
  coach.onBar(1); eq(engine.bpm, 110, 'stepped down');
  coach.onBar(2); eq(engine.bpm, 100, 'reached the lower target');
  eq(coach.gradual.done, true, 'marked done');
});

check('gradual mode reverses when looping is on', () => {
  const engine = new DB.Engine();
  engine.ctx = { currentTime: 0, state: 'running', resume() {} };
  const coach = new DB.Coach(engine);
  coach.gradual = { startBpm: 100, targetBpm: 110, stepBpm: 10, everyBars: 1, loop: true, done: false };
  coach.setMode('gradual');
  coach.onBar(1); eq(engine.bpm, 110, 'climbed to the target');
  eq(coach.gradual.done, false, 'still running');
  coach.onBar(2); eq(engine.bpm, 100, 'headed back down');
});

/* ── Rhythm coach: time check grading ── */

check('nearestGridPoint measures how far a hit was from the beat', () => {
  const { engine } = makeRig((e) => { e.setBpm(120); e.setBeatsPerMeasure(4); });
  run(engine, 2);
  const beatTime = engine.beatLog[2].time;

  const late = engine.nearestGridPoint(beatTime + 0.02, 1);
  near(late.delta, 0.02, 1e-9, 'late hit');

  const early = engine.nearestGridPoint(beatTime - 0.015, 1);
  near(early.delta, -0.015, 1e-9, 'early hit');
});

check('grading against eighths snaps to the nearest half-beat', () => {
  const { engine } = makeRig((e) => { e.setBpm(120); e.setBeatsPerMeasure(4); });
  run(engine, 2);
  const beatTime = engine.beatLog[2].time;
  const hit = engine.nearestGridPoint(beatTime + 0.25 + 0.01, 2);
  near(hit.delta, 0.01, 1e-9, 'offbeat graded against the eighth grid');
});

check('a hit nowhere near the grid is rejected rather than mis-scored', () => {
  const { engine } = makeRig((e) => { e.setBpm(120); });
  run(engine, 2);
  eq(engine.nearestGridPoint(engine.ctx.currentTime + 60, 1), null, 'far-future hit matched a beat');
});

check('time check tallies accuracy, bias and early/late counts', () => {
  const { engine } = makeRig((e) => { e.setBpm(120); e.setBeatsPerMeasure(4); });
  run(engine, 3);
  const coach = new DB.Coach(engine);
  coach.setMode('timecheck');
  coach.timeCheck.toleranceMs = 20;
  engine.isRunning = true;

  const t = engine.beatLog;
  coach._registerHit(t[1].time + 0.005);   // good
  coach._registerHit(t[2].time + 0.050);   // late
  coach._registerHit(t[3].time - 0.045);   // early

  const s = coach.score();
  eq(s.hits, 3, 'hit count');
  eq(s.good, 1, 'good count');
  eq(s.late, 1, 'late count');
  eq(s.early, 1, 'early count');
  eq(s.accuracy, 33, 'accuracy percentage');
  near(s.biasMs, (5 + 50 - 45) / 3, 1e-6, 'timing bias');
});

check('the latency offset shifts grading without changing the audio', () => {
  const { engine } = makeRig((e) => { e.setBpm(120); });
  run(engine, 3);
  const coach = new DB.Coach(engine);
  coach.setMode('timecheck');
  coach.timeCheck.toleranceMs = 10;
  coach.timeCheck.latencyMs = 40;        // mic path reports hits 40 ms late
  engine.isRunning = true;

  // A hit heard 40 ms after the beat was actually played on the beat.
  coach._registerHit(engine.beatLog[1].time + 0.040);
  eq(coach.score().good, 1, 'latency compensation not applied');
});

/* ── Report ── */

console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.message}`);
process.exit(failures.length ? 1 : 0);
