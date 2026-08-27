/* Synthesised click voices.
 * Every voice is built from oscillators / noise so the app ships with no samples.
 * play() must be cheap: it is called from the scheduler up to ~30x per second.
 */
(function (DB) {
  'use strict';

  var noiseBuffer = null;

  function getNoise(ctx) {
    if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
    var len = Math.floor(ctx.sampleRate * 0.5);
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuffer.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  // Percussive envelope: instant attack, exponential decay. Values never reach 0
  // because exponentialRampToValueAtTime rejects a 0 target.
  function env(ctx, dest, time, peak, decay) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    g.connect(dest);
    return g;
  }

  function tone(ctx, dest, time, freq, type, peak, decay, glideTo) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, time);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, time + decay);
    o.connect(env(ctx, dest, time, peak, decay));
    o.start(time);
    o.stop(time + decay + 0.02);
  }

  function noise(ctx, dest, time, freq, q, peak, decay) {
    var s = ctx.createBufferSource();
    s.buffer = getNoise(ctx);
    s.playbackRate.value = 1;
    var f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, time);
    f.Q.value = q;
    s.connect(f);
    f.connect(env(ctx, dest, time, peak, decay));
    s.start(time, Math.random() * 0.2);
    s.stop(time + decay + 0.02);
  }

  // level: 'accent' | 'beat' | 'sub'
  var VOICES = {
    beep: function (ctx, dest, time, level, gain) {
      var spec = { accent: [1800, 0.055], beat: [1200, 0.05], sub: [900, 0.035] }[level];
      tone(ctx, dest, time, spec[0], 'square', gain * 0.35, spec[1]);
    },
    click: function (ctx, dest, time, level, gain) {
      // A narrower band would ring more but passes far less of the noise through,
      // which left this voice several times quieter than the others at the same gain.
      var spec = { accent: [3200, 0.032], beat: [2100, 0.028], sub: [1500, 0.02] }[level];
      noise(ctx, dest, time, spec[0], 6, gain * 1.7, spec[1]);
    },
    stick: function (ctx, dest, time, level, gain) {
      var spec = { accent: [2400, 0.03], beat: [1700, 0.026], sub: [1300, 0.018] }[level];
      noise(ctx, dest, time, spec[0], 3, gain * 0.7, spec[1]);
      tone(ctx, dest, time, spec[0] * 0.45, 'triangle', gain * 0.25, spec[1]);
    },
    cowbell: function (ctx, dest, time, level, gain) {
      var spec = { accent: [845, 587, 0.2], beat: [700, 490, 0.11], sub: [560, 400, 0.06] }[level];
      var g = env(ctx, dest, time, gain * 0.3, spec[2]);
      var f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = spec[0];
      f.Q.value = 1.2;
      f.connect(g);
      [spec[0], spec[1]].forEach(function (fr) {
        var o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.setValueAtTime(fr, time);
        o.connect(f);
        o.start(time);
        o.stop(time + spec[2] + 0.02);
      });
    },
    wood: function (ctx, dest, time, level, gain) {
      var spec = { accent: [1600, 0.045], beat: [1100, 0.04], sub: [850, 0.028] }[level];
      tone(ctx, dest, time, spec[0], 'triangle', gain * 0.5, spec[1], spec[0] * 0.55);
      noise(ctx, dest, time, spec[0] * 1.4, 8, gain * 0.2, 0.012);
    },
    pulse: function (ctx, dest, time, level, gain) {
      var spec = { accent: [880, 0.09], beat: [660, 0.08], sub: [440, 0.05] }[level];
      tone(ctx, dest, time, spec[0], 'sine', gain * 0.45, spec[1]);
    }
  };

  /* Each voice already separates the levels by pitch and decay, but pitch alone
   * is a weak accent — and for the band-passed voices it can even invert, since
   * a filter centred on the higher accent frequency passes less of its own
   * oscillator pair than the low sub does. Scaling level here keeps the accent
   * reliably on top for every voice instead of per-voice tuning that can drift. */
  var LEVEL_GAIN = { accent: 1, beat: 0.78, sub: 0.62 };

  DB.Voices = {
    names: Object.keys(VOICES),
    levelGain: LEVEL_GAIN,
    play: function (ctx, dest, time, level, voice, gain) {
      var fn = VOICES[voice] || VOICES.beep;
      if (gain <= 0.0005) return;
      fn(ctx, dest, time, level, gain * (LEVEL_GAIN[level] || 1));
    }
  };
})(window.DrBeat = window.DrBeat || {});
