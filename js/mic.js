/* One microphone, shared — and a choice of which one.
 *
 * Time Check and take recording both want the input, often at once. This hands
 * out a single stream and closes it when the last user lets go.
 *
 * Device choice matters once an audio interface is involved: with no deviceId
 * the browser hands over its default input, which is usually the built-in mic
 * even when an interface is plugged in. The chosen device is remembered.
 */
(function (DB) {
  'use strict';

  var PREF_KEY = 'drbeat21.audioin.v1';

  var stream = null;
  var pending = null;
  var refs = 0;
  var deviceId = '';
  var stereo = false;

  try {
    var saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    deviceId = saved.deviceId || '';
    stereo = !!saved.stereo;
  } catch (e) { /* no stored preference */ }

  function remember() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ deviceId: deviceId, stereo: stereo }));
    } catch (e) { /* private mode: the choice just will not persist */ }
  }

  function constraints() {
    // All three processors stay off: they are tuned for speech and would
    // mangle an instrument, duck the click, and smear the transient Time
    // Check measures.
    var audio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
    // "exact" rather than "ideal": silently falling back to the laptop mic
    // when the interface is busy is worse than an error that says so.
    if (deviceId) audio.deviceId = { exact: deviceId };
    // Stated both ways on purpose: left unset, the browser picks for itself and
    // the toggle appears to do nothing when it is switched off.
    audio.channelCount = { ideal: stereo ? 2 : 1 };
    return { audio: audio };
  }

  DB.Mic = {
    acquire: function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return Promise.reject(new Error('This browser exposes no microphone API.'));
      }
      refs++;
      if (stream) return Promise.resolve(stream);
      if (pending) return pending;

      pending = navigator.mediaDevices.getUserMedia(constraints()).then(function (s) {
        stream = s;
        pending = null;
        return s;
      }).catch(function (e) {
        // A failed acquire must not leave a phantom reference behind.
        refs = Math.max(0, refs - 1);
        pending = null;
        if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') && deviceId) {
          throw new Error('That input is not available any more — pick another one.');
        }
        throw e;
      });
      return pending;
    },

    release: function () {
      refs = Math.max(0, refs - 1);
      if (refs === 0 && stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null;
      }
    },

    /* Changing device cannot re-point a graph that is already running: the
     * worklet and recorder are wired to the old source node. Report whether
     * anything has to be restarted and let the caller handle it. */
    setDevice: function (id) {
      if (id === deviceId) return { restartNeeded: false };
      deviceId = id || '';
      remember();
      var wasInUse = refs > 0;
      if (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null;
        refs = 0;
      }
      return { restartNeeded: wasInUse };
    },

    setStereo: function (on) {
      if (!!on === stereo) return { restartNeeded: false };
      stereo = !!on;
      remember();
      var wasInUse = refs > 0;
      if (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null;
        refs = 0;
      }
      return { restartNeeded: wasInUse };
    },

    device: function () { return deviceId; },
    stereo: function () { return stereo; },

    /* Device labels are hidden until the page has been granted the mic once,
     * so an unlabelled list means "not permitted yet", not "no devices". */
    devices: function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return Promise.resolve({ inputs: [], outputs: [], labelled: false });
      }
      return navigator.mediaDevices.enumerateDevices().then(function (list) {
        var inputs = list.filter(function (d) { return d.kind === 'audioinput'; });
        var outputs = list.filter(function (d) { return d.kind === 'audiooutput'; });
        return {
          inputs: inputs,
          outputs: outputs,
          labelled: inputs.some(function (d) { return !!d.label; })
        };
      }).catch(function () { return { inputs: [], outputs: [], labelled: false }; });
    },

    /* Reported capture latency in seconds, used to line the click up with the
     * playing in a recorded take. It is a hint from the browser, not a measurement. */
    inputLatency: function () {
      if (!stream) return 0;
      var track = stream.getAudioTracks()[0];
      if (!track || !track.getSettings) return 0;
      var s = track.getSettings();
      return typeof s.latency === 'number' ? s.latency : 0;
    },

    settings: function () {
      if (!stream) return null;
      var track = stream.getAudioTracks()[0];
      return track && track.getSettings ? track.getSettings() : null;
    },

    active: function () { return !!stream; },
    refCount: function () { return refs; }
  };
})(window.DrBeat = window.DrBeat || {});
