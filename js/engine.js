/* Metronome timing engine.
 *
 * Timing model: a setInterval "ticker" wakes up every LOOKAHEAD_MS and schedules
 * every grid position falling inside the next SCHEDULE_AHEAD seconds directly on
 * the AudioContext clock. setInterval jitter therefore never reaches the audio —
 * it only decides how early events are queued. (Chris Wilson, "A Tale of Two Clocks".)
 *
 * Grid resolution is 12 ticks per beat: 12 divides by 1 (beat), 2 (eighths),
 * 3 (triplets) and 4 (sixteenths), so every subdivision layer lands on an exact
 * integer tick and layers stay phase-locked to each other.
 */
(function (DB) {
  'use strict';

  var TICKS_PER_BEAT = 12;
  var LOOKAHEAD_MS = 25;
  var SCHEDULE_AHEAD = 0.12;

  // tick offset within a beat -> which layers fire there
  var LAYER_TICKS = {
    quarter: [0],
    eighth: [0, 6],
    triplet: [0, 4, 8],
    sixteenth: [0, 3, 6, 9],
    shuffle: [0, 8] // swung eighths: second note two thirds through the beat
  };

  function Engine() {
    this.ctx = null;
    this.masterGain = null;
    this.timerId = null;

    this.isRunning = false;
    this.bpm = 120;
    this.beatsPerMeasure = 4;
    this.beatUnit = 4;              // 2 | 4 | 8 | 16 — the note value that gets a click
    this.accents = [2, 1, 1, 1];    // 2 = accent, 1 = normal, 0 = silent
    this.voice = 'beep';
    this.volume = 0.8;
    this.muted = false;             // driven by the Quiet Count coach

    this.layers = {
      quarter:   { on: true,  vol: 1.0 },
      eighth:    { on: false, vol: 0.55 },
      triplet:   { on: false, vol: 0.55 },
      sixteenth: { on: false, vol: 0.45 },
      shuffle:   { on: false, vol: 0.55 }
    };

    this.tick = 0;                  // absolute tick counter since start
    this.nextTickTime = 0;
    this.beatLog = [];              // recent scheduled beats, for Time Check grading

    // Callbacks (set by ui.js / coach.js)
    this.onBeatScheduled = null;    // (info) at schedule time — lets the coach act ahead
    this.onBarScheduled = null;     // (barIndex, time)
    this.onVisualBeat = null;       // (info) at audible time — drives the LEDs
    this.onTickScheduled = null;    // (tick, time) — drives the MIDI clock

    this._visualQueue = [];
    this._rafId = null;
  }

  Engine.prototype.ensureContext = function () {
    if (!this.ctx) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  };

  Engine.prototype.secondsPerBeat = function () {
    // BPM always refers to the quarter note; a 6/8 bar at 120 clicks eighths.
    return (60 / this.bpm) * (4 / this.beatUnit);
  };

  Engine.prototype.setVolume = function (v) {
    this.volume = v;
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
    }
  };

  /* Changing tempo mid-run must not retime the tick already queued, otherwise the
   * beat under the playhead shifts. Only ticks scheduled after this point use the
   * new spacing, so a tempo change is always seamless. */
  Engine.prototype.setBpm = function (bpm) {
    this.bpm = Math.min(250, Math.max(30, Math.round(bpm)));
  };

  Engine.prototype.setBeatsPerMeasure = function (n) {
    n = Math.max(0, Math.min(9, n | 0));
    this.beatsPerMeasure = n;
    var a = this.accents.slice(0, Math.max(n, 1));
    while (a.length < Math.max(n, 1)) a.push(1);
    if (n > 0) a[0] = a[0] === 0 ? 2 : a[0];
    this.accents = a;
  };

  Engine.prototype.start = function () {
    if (this.isRunning) return;
    this.ensureContext();
    this.isRunning = true;
    this.tick = 0;
    this.beatLog = [];
    this._visualQueue = [];
    // Small offset so the first tick is scheduled, not fired late.
    this.nextTickTime = this.ctx.currentTime + 0.06;
    var self = this;
    this.timerId = setInterval(function () { self._scheduler(); }, LOOKAHEAD_MS);
    this._scheduler();
    this._startVisualLoop();
  };

  Engine.prototype.stop = function () {
    if (!this.isRunning) return;
    this.isRunning = false;
    clearInterval(this.timerId);
    this.timerId = null;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    this._visualQueue = [];
  };

  Engine.prototype.toggle = function () {
    if (this.isRunning) this.stop(); else this.start();
  };

  Engine.prototype._scheduler = function () {
    var horizon = this.ctx.currentTime + SCHEDULE_AHEAD;
    while (this.nextTickTime < horizon) {
      this._scheduleTick(this.tick, this.nextTickTime);
      this.nextTickTime += this.secondsPerBeat() / TICKS_PER_BEAT;
      this.tick++;
    }
  };

  Engine.prototype._scheduleTick = function (tick, time) {
    var offset = tick % TICKS_PER_BEAT;
    var beatNo = Math.floor(tick / TICKS_PER_BEAT);
    var bpmMeasure = this.beatsPerMeasure || 1;
    var beatIndex = beatNo % bpmMeasure;
    var barIndex = Math.floor(beatNo / bpmMeasure);

    if (this.onTickScheduled) this.onTickScheduled(tick, time);

    if (offset === 0) {
      if (beatIndex === 0 && this.onBarScheduled) this.onBarScheduled(barIndex, time);

      var accent = this.beatsPerMeasure === 0 ? 1 : (this.accents[beatIndex] === undefined ? 1 : this.accents[beatIndex]);
      var info = { time: time, beatIndex: beatIndex, barIndex: barIndex, accent: accent, muted: this.muted };
      if (this.onBeatScheduled) this.onBeatScheduled(info);
      this._visualQueue.push(info);

      this.beatLog.push({ time: time, beatIndex: beatIndex, barIndex: barIndex });
      // Keep roughly the last 10s so Time Check can match a hit to its beat.
      var cutoff = this.ctx.currentTime - 10;
      while (this.beatLog.length && this.beatLog[0].time < cutoff) this.beatLog.shift();
    }

    if (this.muted) return;

    var beatAudible = this.layers.quarter.on;
    var accentLevel = this.beatsPerMeasure === 0 ? 1 : (this.accents[beatIndex] === undefined ? 1 : this.accents[beatIndex]);

    if (offset === 0 && beatAudible) {
      if (accentLevel > 0) {
        DB.Voices.play(this.ctx, this.masterGain, time,
          accentLevel === 2 ? 'accent' : 'beat', this.voice, this.layers.quarter.vol);
      }
    }

    // Subdivision layers. They skip tick 0 only when the beat click itself is
    // audible there, so turning the quarter layer off keeps the grid complete.
    var self = this;
    ['eighth', 'triplet', 'sixteenth', 'shuffle'].forEach(function (name) {
      var layer = self.layers[name];
      if (!layer.on) return;
      if (LAYER_TICKS[name].indexOf(offset) === -1) return;
      if (offset === 0 && beatAudible) return;
      if (offset === 0 && accentLevel === 0) return;
      DB.Voices.play(self.ctx, self.masterGain, time, 'sub', self.voice, layer.vol);
    });
  };

  /* The audio is scheduled ahead of time, so the LEDs must be released on the
   * audio clock rather than when the event was queued. */
  Engine.prototype._startVisualLoop = function () {
    var self = this;
    function frame() {
      if (!self.isRunning) return;
      var now = self.ctx.currentTime;
      while (self._visualQueue.length && self._visualQueue[0].time <= now) {
        var info = self._visualQueue.shift();
        if (self.onVisualBeat) self.onVisualBeat(info);
      }
      self._rafId = requestAnimationFrame(frame);
    }
    this._rafId = requestAnimationFrame(frame);
  };

  /* Nearest grid position to a given audio time, used by Time Check.
   * grid = 1 grades against beats, 2 against eighths, etc. */
  Engine.prototype.nearestGridPoint = function (time, grid) {
    if (!this.beatLog.length) return null;
    var spb = this.secondsPerBeat();
    var step = spb / grid;
    var best = null;
    for (var i = 0; i < this.beatLog.length; i++) {
      var b = this.beatLog[i];
      for (var k = 0; k < grid; k++) {
        var t = b.time + k * step;
        var d = time - t;
        if (best === null || Math.abs(d) < Math.abs(best.delta)) {
          best = { delta: d, target: t, beatIndex: b.beatIndex, barIndex: b.barIndex, sub: k };
        }
      }
    }
    // Guard against matching a stale beat when the log has not caught up yet.
    if (best && Math.abs(best.delta) > step) return null;
    return best;
  };

  Engine.prototype.playReferenceTone = null; // attached by ui.js

  DB.Engine = Engine;
  DB.TICKS_PER_BEAT = TICKS_PER_BEAT;
})(window.DrBeat = window.DrBeat || {});
