/* Rhythm Coach — the three practice modes the DB-90 is actually bought for.
 *
 *  Quiet Count   play N bars, mute M bars, repeat. Optionally widen the silence
 *                every cycle so you are gradually left alone with your own time.
 *  Gradual U/D   step the tempo by X BPM every N bars between two tempi.
 *  Time Check    listen on the microphone, match each hit to the nearest grid
 *                point and grade how far off it was.
 */
(function (DB) {
  'use strict';

  /* Onset detection runs in an AudioWorklet so a hit is timestamped to the sample
   * that crossed the threshold. Doing it from requestAnimationFrame would quantise
   * every measurement to the ~16 ms frame boundary, which is the same order as the
   * error being measured. The processor source is loaded through a Blob URL so the
   * app still works when opened straight from disk. */
  var WORKLET_SRC = [
    'class OnsetProcessor extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super();',
    '    this.threshold = 0.06;',
    '    this.refractory = 0.07;',
    '    this.last = -1;',
    '    this.envelope = 0;',
    '    this.port.onmessage = (e) => {',
    '      if (e.data && typeof e.data.threshold === "number") this.threshold = e.data.threshold;',
    '    };',
    '  }',
    '  process(inputs) {',
    '    const ch = inputs[0] && inputs[0][0];',
    '    if (!ch) return true;',
    '    let peak = 0;',
    '    for (let i = 0; i < ch.length; i++) {',
    '      const v = Math.abs(ch[i]);',
    '      if (v > peak) peak = v;',
    '      // Follow the envelope fast on the way up, slowly on the way down, so a',
    '      // single stroke fires once instead of once per sample above threshold.',
    '      this.envelope = v > this.envelope ? v : this.envelope * 0.9995;',
    '      const t = currentTime + i / sampleRate;',
    '      if (v > this.threshold && v >= this.envelope && t - this.last > this.refractory) {',
    '        this.last = t;',
    '        this.port.postMessage({ time: t, level: v });',
    '      }',
    '    }',
    '    this.port.postMessage({ meter: peak });',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("onset-processor", OnsetProcessor);'
  ].join('\n');

  function Coach(engine) {
    this.engine = engine;
    this.mode = 'off';
    this.onUpdate = null;   // (state) -> void, for the UI readouts
    this.onHit = null;      // (result) -> void, Time Check feedback

    this.quiet = { playBars: 1, muteBars: 1, gradual: false, maxMute: 8, cycleStartBar: null, cycles: 0 };
    this.gradual = { startBpm: 80, targetBpm: 140, stepBpm: 4, everyBars: 2, loop: false, done: false };
    this.timeCheck = {
      grid: 1, toleranceMs: 30, latencyMs: 0, threshold: 0.06,
      hits: 0, good: 0, early: 0, late: 0, sumAbs: 0, sumSigned: 0, level: 0, running: false
    };

    this._stream = null;
    this._node = null;
    this._src = null;
    this._sink = null;
  }

  Coach.prototype.setMode = function (mode) {
    if (this.mode === mode) return;
    if (this.mode === 'timecheck') this.stopListening();
    this.mode = mode;
    this.engine.muted = false;
    this.quiet.cycleStartBar = null;
    this.quiet.cycles = 0;
    this.gradual.done = false;
    if (mode === 'gradual') this.engine.setBpm(this.gradual.startBpm);
    if (mode === 'timecheck') this.resetScore();
    this._emit();
  };

  Coach.prototype.reset = function () {
    this.quiet.cycleStartBar = null;
    this.quiet.cycles = 0;
    this.gradual.done = false;
    this.engine.muted = false;
    if (this.mode === 'gradual') this.engine.setBpm(this.gradual.startBpm);
    if (this.mode === 'timecheck') this.resetScore();
    this._emit();
  };

  Coach.prototype.resetScore = function () {
    var t = this.timeCheck;
    t.hits = 0; t.good = 0; t.early = 0; t.late = 0; t.sumAbs = 0; t.sumSigned = 0;
    this._emit();
  };

  /* Called from the engine at schedule time, i.e. slightly before the bar is
   * heard — which is exactly when a tempo or mute change has to be decided. */
  Coach.prototype.onBar = function (barIndex) {
    if (this.mode === 'quiet') this._quietOnBar(barIndex);
    else if (this.mode === 'gradual') this._gradualOnBar(barIndex);
    this._emit();
  };

  /* Position within the cycle is derived from the bar index against an anchor,
   * never from a count of how often this ran: a dropped or repeated call would
   * otherwise shift the sounding/silent phase permanently. The anchor also lets
   * the cycle length change underneath us, which is what gradual widening does. */
  Coach.prototype._quietOnBar = function (barIndex) {
    var q = this.quiet;
    if (q.playBars + q.muteBars <= 0) { this.engine.muted = false; return; }
    if (q.cycleStartBar === null) q.cycleStartBar = barIndex;

    var pos = barIndex - q.cycleStartBar;
    if (pos >= q.playBars + q.muteBars) {
      q.cycles++;
      if (q.gradual && q.muteBars < q.maxMute) q.muteBars++;
      q.cycleStartBar = barIndex;
      pos = 0;
    }
    this.engine.muted = pos >= q.playBars;
  };

  Coach.prototype._gradualOnBar = function (barIndex) {
    var g = this.gradual;
    if (g.done) return;
    if (barIndex === 0 || barIndex % g.everyBars !== 0) return;

    var up = g.targetBpm >= g.startBpm;
    var next = this.engine.bpm + (up ? g.stepBpm : -g.stepBpm);
    var reached = up ? next >= g.targetBpm : next <= g.targetBpm;

    if (reached) {
      this.engine.setBpm(g.targetBpm);
      if (g.loop) {
        // Swap the endpoints and keep climbing/descending the other way.
        var s = g.startBpm; g.startBpm = g.targetBpm; g.targetBpm = s;
      } else {
        g.done = true;
      }
    } else {
      this.engine.setBpm(next);
    }
  };

  /* ---- Time Check ---- */

  Coach.prototype.startListening = function () {
    var self = this;
    var ctx = this.engine.ensureContext();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('This browser exposes no microphone API.'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,   // all three would smear the transient we measure
        noiseSuppression: false,
        autoGainControl: false
      }
    }).then(function (stream) {
      self._stream = stream;
      var blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
      var url = URL.createObjectURL(blob);
      return ctx.audioWorklet.addModule(url).then(function () {
        URL.revokeObjectURL(url);
        self._src = ctx.createMediaStreamSource(stream);
        self._node = new AudioWorkletNode(ctx, 'onset-processor');
        self._node.port.postMessage({ threshold: self.timeCheck.threshold });
        self._node.port.onmessage = function (e) {
          if (e.data.meter !== undefined) { self.timeCheck.level = e.data.meter; return; }
          self._registerHit(e.data.time);
        };
        // A muted sink keeps the graph pulling audio without monitoring the mic
        // back through the speakers (which would feed the clicks straight back in).
        self._sink = ctx.createGain();
        self._sink.gain.value = 0;
        self._src.connect(self._node);
        self._node.connect(self._sink);
        self._sink.connect(ctx.destination);
        self.timeCheck.running = true;
        self._emit();
      });
    });
  };

  Coach.prototype.stopListening = function () {
    if (this._node) { try { this._node.disconnect(); } catch (e) {} this._node = null; }
    if (this._src) { try { this._src.disconnect(); } catch (e) {} this._src = null; }
    if (this._sink) { try { this._sink.disconnect(); } catch (e) {} this._sink = null; }
    if (this._stream) {
      this._stream.getTracks().forEach(function (t) { t.stop(); });
      this._stream = null;
    }
    this.timeCheck.running = false;
    this.timeCheck.level = 0;
    this._emit();
  };

  Coach.prototype.setThreshold = function (v) {
    this.timeCheck.threshold = v;
    if (this._node) this._node.port.postMessage({ threshold: v });
  };

  Coach.prototype._registerHit = function (rawTime) {
    if (!this.engine.isRunning) return;
    var t = this.timeCheck;
    // The mic path adds latency the browser will not tell us about reliably, so
    // the offset is a user-set calibration rather than a computed value.
    var time = rawTime - t.latencyMs / 1000;
    var match = this.engine.nearestGridPoint(time, t.grid);
    if (!match) return;

    var deltaMs = match.delta * 1000;
    t.hits++;
    t.sumAbs += Math.abs(deltaMs);
    t.sumSigned += deltaMs;
    var verdict;
    if (Math.abs(deltaMs) <= t.toleranceMs) { t.good++; verdict = 'good'; }
    else if (deltaMs < 0) { t.early++; verdict = 'early'; }
    else { t.late++; verdict = 'late'; }

    if (this.onHit) this.onHit({ deltaMs: deltaMs, verdict: verdict, beatIndex: match.beatIndex });
    this._emit();
  };

  Coach.prototype.score = function () {
    var t = this.timeCheck;
    return {
      hits: t.hits,
      accuracy: t.hits ? Math.round((t.good / t.hits) * 100) : 0,
      avgAbsMs: t.hits ? t.sumAbs / t.hits : 0,
      biasMs: t.hits ? t.sumSigned / t.hits : 0,
      early: t.early,
      late: t.late,
      good: t.good
    };
  };

  Coach.prototype._emit = function () {
    if (this.onUpdate) this.onUpdate(this);
  };

  DB.Coach = Coach;
})(window.DrBeat = window.DrBeat || {});
