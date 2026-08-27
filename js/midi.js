/* MIDI clock output — lets the app drive a drum machine, looper or DAW,
 * the way the DB-90's MIDI OUT does.
 *
 * The MIDI spec wants 24 clock bytes per quarter note. The engine's grid is
 * 12 ticks per beat, so each scheduled tick emits two clocks, the second one
 * half a tick later. Messages are sent with an explicit timestamp rather than
 * "now", so they inherit the scheduler's accuracy instead of setInterval's.
 */
(function (DB) {
  'use strict';

  function MidiClock(engine) {
    this.engine = engine;
    this.access = null;
    this.output = null;
    this.enabled = false;
    this.onOutputs = null;
  }

  MidiClock.prototype.supported = function () {
    return typeof navigator.requestMIDIAccess === 'function';
  };

  MidiClock.prototype.init = function () {
    var self = this;
    if (!this.supported()) return Promise.reject(new Error('Web MIDI is not available in this browser.'));
    return navigator.requestMIDIAccess({ sysex: false }).then(function (access) {
      self.access = access;
      access.onstatechange = function () { self._publish(); };
      self._publish();
      return access;
    });
  };

  MidiClock.prototype.outputs = function () {
    if (!this.access) return [];
    var list = [];
    this.access.outputs.forEach(function (o) { list.push({ id: o.id, name: o.name }); });
    return list;
  };

  MidiClock.prototype._publish = function () {
    if (this.onOutputs) this.onOutputs(this.outputs());
  };

  MidiClock.prototype.selectOutput = function (id) {
    this.output = (this.access && id) ? this.access.outputs.get(id) : null;
  };

  // Audio-clock seconds -> the DOMHighResTimeStamp that MIDIOutput.send expects.
  MidiClock.prototype._toDomTime = function (audioTime) {
    var ctx = this.engine.ctx;
    return performance.now() + (audioTime - ctx.currentTime) * 1000;
  };

  MidiClock.prototype.sendStart = function () {
    if (!this.enabled || !this.output) return;
    this.output.send([0xFA]);
  };

  MidiClock.prototype.sendStop = function () {
    if (!this.output) return;
    this.output.send([0xFC]);
  };

  MidiClock.prototype.onTick = function (tick, time) {
    if (!this.enabled || !this.output) return;
    var half = (this.engine.secondsPerBeat() / DB.TICKS_PER_BEAT) / 2;
    this.output.send([0xF8], this._toDomTime(time));
    this.output.send([0xF8], this._toDomTime(time + half));
  };

  DB.MidiClock = MidiClock;
})(window.DrBeat = window.DrBeat || {});
