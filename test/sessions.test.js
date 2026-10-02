/* Practice log tests — fake clock, fake localStorage, no browser.
 *
 *   node test/sessions.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ── Sandbox ── */

function makeSandbox() {
  const store = new Map();
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear()
    },
    console
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'sessions.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'sessions.js' });
  return { DB: sandbox.window.DrBeat, store };
}

/* ── Harness ── */

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); }
}
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const MIN = 60000;
const HOUR = 60 * MIN;

// A clock we drive by hand, so "five minutes later" is exact and instant.
function rig(opts) {
  const { DB, store } = makeSandbox();
  let clock = Date.UTC(2026, 8, 20, 10, 0, 0);
  const log = new DB.PracticeLog(Object.assign({ now: () => clock }, opts || {}));
  return {
    DB, log, store,
    advance: (ms) => { clock += ms; },
    at: (ms) => { clock = ms; },
    now: () => clock
  };
}

// One complete run: start, play `beats` beats, stop after `ms`.
function run(r, ms, beats, info) {
  r.log.beginSegment(Object.assign({
    bpm: 120, meter: { beatsPerBar: 4, beatUnit: 4, label: '4/4' }, coach: 'off', layers: ['quarter']
  }, info || {}));
  for (let i = 0; i < beats; i++) r.log.countBeat((info && info.bpm) || 120);
  r.advance(ms);
  return r.log.endSegment(info && info.extra);
}

/* ── Session grouping ── */

check('a run too short to be practice is discarded', () => {
  const r = rig();
  run(r, 2000, 4);
  eq(r.log.all().length, 0, 'stored sessions');
  eq(r.log.current(), null, 'open session');
});

check('runs close together belong to one session', () => {
  const r = rig();
  run(r, 30000, 60);
  r.advance(2 * MIN);           // a breather, inside the idle gap
  run(r, 30000, 60);
  const list = r.log.all();
  eq(list.length, 1, 'session count');
  eq(list[0].segments.length, 2, 'runs in the session');
  eq(list[0].playMs, 60000, 'total played');
});

check('a long gap starts a new session', () => {
  const r = rig();
  run(r, 30000, 60);
  r.advance(20 * MIN);          // well past the 5 minute gap
  run(r, 30000, 60);
  eq(r.log.all().length, 2, 'session count');
});

check('the idle gap is measured from the end of the last run', () => {
  const r = rig();
  run(r, 10 * MIN, 100);        // a long run
  r.advance(4 * MIN);           // still inside the gap
  run(r, 30000, 60);
  eq(r.log.all().length, 1, 'a long run must not age out its own session');
});

/* ── Aggregation ── */

check('beats, bars and tempo range accumulate across runs', () => {
  const r = rig();
  run(r, 30000, 8, { bpm: 100 });
  r.advance(MIN);
  run(r, 30000, 12, { bpm: 150 });
  const s = r.log.all()[0];
  eq(s.beats, 20, 'beats');
  eq(s.bars, 5, 'bars (20 beats of 4/4)');
  eq(s.bpmMin, 100, 'slowest tempo');
  eq(s.bpmMax, 150, 'fastest tempo');
});

check('a tempo ramp inside one run is captured', () => {
  const r = rig();
  r.log.beginSegment({ bpm: 80, meter: { beatsPerBar: 4, beatUnit: 4 }, coach: 'gradual' });
  [80, 90, 100, 110, 120].forEach((b) => r.log.countBeat(b));
  r.advance(30000);
  r.log.endSegment();
  const s = r.log.all()[0];
  eq(s.bpmMin, 80, 'start of the ramp');
  eq(s.bpmMax, 120, 'end of the ramp');
  eq(s.segments[0].bpmEnd, 120, 'tempo left at');
});

check('coach modes are collected without duplicates', () => {
  const r = rig();
  run(r, 20000, 10, { coach: 'quiet' });
  r.advance(MIN);
  run(r, 20000, 10, { coach: 'quiet' });
  r.advance(MIN);
  run(r, 20000, 10, { coach: 'gradual' });
  eq(r.log.all()[0].coachModes.join(','), 'quiet,gradual', 'modes used');
});

check('a Time Check score is attached, and an empty one is not', () => {
  const r = rig();
  run(r, 20000, 10, { extra: { timeCheck: { hits: 0, accuracy: 0, avgAbsMs: 0, biasMs: 0 } } });
  eq(r.log.all()[0].timeCheck, null, 'a score with no hits is not worth keeping');
  r.advance(MIN);
  run(r, 20000, 10, { extra: { timeCheck: { hits: 12, accuracy: 75, avgAbsMs: 18.2, biasMs: -4.1 } } });
  eq(r.log.all()[0].timeCheck.accuracy, 75, 'score attached');
});

check('counting a beat outside a run is ignored', () => {
  const r = rig();
  r.log.countBeat(120);                    // no segment open
  run(r, 20000, 5);
  eq(r.log.all()[0].beats, 5, 'stray beats must not be counted');
});

check('a dropped session is not resurrected by a later short run', () => {
  const r = rig();
  run(r, 30000, 60);
  r.advance(20 * MIN);
  run(r, 1000, 2);                         // too short, opens then discards
  eq(r.log.all().length, 1, 'session count');
});

/* ── Stats ── */

check('per-day buckets follow when each run happened', () => {
  const r = rig();
  r.at(new Date(2026, 8, 18, 9, 0, 0).getTime());
  run(r, 20 * MIN, 100);
  r.at(new Date(2026, 8, 20, 9, 0, 0).getTime());
  run(r, 10 * MIN, 50);

  const stats = r.log.stats(14);
  const byDay = {};
  stats.series.forEach((p) => { byDay[p.day] = p.ms; });
  eq(byDay['2026-09-18'], 20 * MIN, 'minutes on the 18th');
  eq(byDay['2026-09-19'], 0, 'nothing on the 19th');
  eq(byDay['2026-09-20'], 10 * MIN, 'minutes on the 20th');
  eq(stats.series.length, 14, 'window length');
});

check('a session spanning midnight splits across both days', () => {
  const r = rig();
  r.at(new Date(2026, 8, 19, 23, 50, 0).getTime());
  run(r, 15 * MIN, 50);                    // ends 00:05
  r.advance(MIN);                          // still one session
  run(r, 10 * MIN, 40);                    // entirely on the 20th

  eq(r.log.all().length, 1, 'still a single session');
  const byDay = {};
  r.log.stats(14).series.forEach((p) => { byDay[p.day] = p.ms; });
  eq(byDay['2026-09-19'], 15 * MIN, 'the run that began before midnight');
  eq(byDay['2026-09-20'], 10 * MIN, 'the run that began after it');
});

check('the streak counts back from today and stops at the first blank day', () => {
  const r = rig();
  const base = new Date(2026, 8, 20, 12, 0, 0).getTime();
  [4, 2, 1, 0].forEach((daysAgo) => {       // note: nothing 3 days ago
    r.at(base - daysAgo * 86400000);
    run(r, 10 * MIN, 30);
    r.advance(HOUR);
  });
  r.at(base + HOUR);
  eq(r.log.stats(14).streak, 3, 'today plus the two before it');
});

check('a run in progress already counts toward the totals', () => {
  const r = rig();
  r.log.beginSegment({ bpm: 120, meter: { beatsPerBar: 4, beatUnit: 4 } });
  r.advance(6 * MIN);
  const stats = r.log.stats(14);
  eq(stats.series[stats.series.length - 1].ms, 6 * MIN, 'live minutes on today');
  eq(stats.totalMs, 6 * MIN, 'live minutes in the total');
});

check('the week total ignores anything older than seven days', () => {
  const r = rig();
  const base = new Date(2026, 8, 20, 12, 0, 0).getTime();
  r.at(base - 10 * 86400000);
  run(r, 30 * MIN, 100);
  r.at(base - 2 * 86400000);
  run(r, 20 * MIN, 100);
  r.at(base);
  eq(r.log.stats(14).weekMs, 20 * MIN, 'only the recent session');
});

/* ── Storage ── */

check('sessions survive a reload', () => {
  const r = rig();
  run(r, 30000, 60);
  const second = new r.DB.PracticeLog({ now: r.now });
  eq(second.all().length, 1, 'read back from storage');
});

check('labels, delete and clear all work', () => {
  const r = rig();
  run(r, 30000, 60);
  const id = r.log.all()[0].id;
  r.log.setLabel(id, 'Etude no.3');
  eq(r.log.all()[0].label, 'Etude no.3', 'label saved');
  r.log.remove(id);
  eq(r.log.all().length, 0, 'removed');
  run(r, 30000, 60);
  r.log.clear();
  eq(r.log.all().length, 0, 'cleared');
});

check('the log is capped so storage cannot grow without bound', () => {
  const r = rig({ maxSessions: 3 });
  for (let i = 0; i < 6; i++) {
    run(r, 30000, 10);
    r.advance(30 * MIN);
  }
  eq(r.log.all().length, 3, 'capped');
});

check('corrupt storage degrades to an empty log instead of throwing', () => {
  const { DB, store } = makeSandbox();
  store.set('drbeat21.sessions.v1', '{not json');
  const log = new DB.PracticeLog();
  eq(log.all().length, 0, 'unreadable storage reads as empty');
});

/* ── Export ── */

check('CSV quotes anything that would break the columns', () => {
  const r = rig();
  run(r, 30000, 60);
  r.log.setLabel(r.log.all()[0].id, 'Bach, "Partita" no.2');
  const csv = r.log.toCSV();
  const lines = csv.split('\n');
  eq(lines.length, 2, 'header plus one row');
  eq(lines[0].split(',')[0], 'started', 'header');
  if (lines[1].indexOf('"Bach, ""Partita"" no.2"') === -1) {
    throw new Error('label was not escaped: ' + lines[1]);
  }
});

check('CSV carries the Time Check score when there is one', () => {
  const r = rig();
  run(r, 30000, 60, { extra: { timeCheck: { hits: 10, accuracy: 80, avgAbsMs: 14.25, biasMs: 2.5 } } });
  const row = r.log.toCSV().split('\n')[1];
  if (row.indexOf('80,14.3,2.5') === -1) throw new Error('score missing from CSV: ' + row);
});

/* ── Report ── */

console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.message}`);
process.exit(failures.length ? 1 : 0);
