/* One microphone, shared.
 *
 * Time Check and take recording both want the mic, often at the same time.
 * Opening it twice means two permission prompts and two device handles, so
 * this hands out a single stream and closes it when the last user lets go.
 */
(function (DB) {
  'use strict';

  var stream = null;
  var pending = null;
  var refs = 0;

  // All three are off deliberately: AGC and noise suppression smear the
  // transient Time Check measures, and echo cancellation would duck the click.
  var CONSTRAINTS = {
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  };

  DB.Mic = {
    acquire: function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return Promise.reject(new Error('This browser exposes no microphone API.'));
      }
      refs++;
      if (stream) return Promise.resolve(stream);
      if (pending) return pending;

      pending = navigator.mediaDevices.getUserMedia(CONSTRAINTS).then(function (s) {
        stream = s;
        pending = null;
        return s;
      }).catch(function (e) {
        // A failed acquire must not leave a phantom reference behind, or the
        // device would never be released.
        refs = Math.max(0, refs - 1);
        pending = null;
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

    active: function () { return !!stream; },
    refCount: function () { return refs; }
  };
})(window.DrBeat = window.DrBeat || {});
