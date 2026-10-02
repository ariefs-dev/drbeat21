/* Audio takes — record yourself playing along, keep it in the browser.
 *
 * The recording is the microphone AND the metronome mixed together in Web Audio
 * before it reaches MediaRecorder. Recording the bare mic would mean the click
 * is on the take only when you practise on speakers and missing whenever you
 * wear headphones; mixing makes the take identical either way.
 *
 * Takes are audio and get large, so they live in IndexedDB (localStorage would
 * blow its quota immediately) and are split across two stores: light metadata
 * that the list reads on every render, and the blobs, fetched only on play.
 */
(function (DB) {
  'use strict';

  var DB_NAME = 'drbeat21';
  var DB_VERSION = 1;
  var META = 'takeMeta';
  var BLOBS = 'takeBlobs';

  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    if (!window.indexedDB) return Promise.reject(new Error('This browser has no IndexedDB.'));
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(META)) {
          var store = db.createObjectStore(META, { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId', { unique: false });
          store.createIndex('startedAt', 'startedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB refused to open.')); };
    }).catch(function (e) { dbPromise = null; throw e; });
    return dbPromise;
  }

  function tx(stores, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(stores, mode);
        var out = fn(t);
        t.oncomplete = function () { resolve(out && out.value !== undefined ? out.value : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  function requestValue(req, box) {
    req.onsuccess = function () { box.value = req.result; };
    return box;
  }

  DB.Takes = {
    supported: function () { return !!window.indexedDB && typeof MediaRecorder === 'function'; },

    add: function (meta, blob) {
      return tx([META, BLOBS], 'readwrite', function (t) {
        t.objectStore(META).put(meta);
        t.objectStore(BLOBS).put({ id: meta.id, blob: blob });
        return { value: meta };
      });
    },

    list: function () {
      return tx([META], 'readonly', function (t) {
        return requestValue(t.objectStore(META).getAll(), {});
      }).then(function (rows) {
        return (rows || []).sort(function (a, b) { return b.startedAt - a.startedAt; });
      });
    },

    blob: function (id) {
      return tx([BLOBS], 'readonly', function (t) {
        return requestValue(t.objectStore(BLOBS).get(id), {});
      }).then(function (row) { return row ? row.blob : null; });
    },

    remove: function (id) {
      return tx([META, BLOBS], 'readwrite', function (t) {
        t.objectStore(META).delete(id);
        t.objectStore(BLOBS).delete(id);
      });
    },

    clear: function () {
      return tx([META, BLOBS], 'readwrite', function (t) {
        t.objectStore(META).clear();
        t.objectStore(BLOBS).clear();
      });
    },

    /* Total of the stored sizes — read from metadata so this never has to pull
     * the blobs themselves into memory just to add up bytes. */
    bytes: function () {
      return this.list().then(function (rows) {
        return rows.reduce(function (sum, r) { return sum + (r.size || 0); }, 0);
      });
    }
  };

  /* ---- Recorder ---- */

  // Chromium gives Opus in WebM; Safari only does MP4/AAC. Asking for an
  // unsupported type throws, so pick one the browser admits to supporting.
  function pickMime() {
    if (typeof MediaRecorder !== 'function' || !MediaRecorder.isTypeSupported) return '';
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function extensionFor(mime) {
    if (mime.indexOf('mp4') >= 0) return 'm4a';
    if (mime.indexOf('ogg') >= 0) return 'ogg';
    return 'webm';
  }

  function TakeRecorder(engine) {
    this.engine = engine;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.meta = null;
    this.appliedLatency = 0;
    this._dest = null;
    this._micSource = null;
    this._clickTap = null;
    this._clickDelay = null;
  }

  TakeRecorder.prototype.supported = function () { return DB.Takes.supported(); };
  TakeRecorder.prototype.isRecording = function () {
    return !!this.recorder && this.recorder.state === 'recording';
  };
  TakeRecorder.prototype.elapsedMs = function () {
    return this.isRecording() ? Date.now() - this.startedAt : 0;
  };

  TakeRecorder.prototype.start = function (meta) {
    var self = this;
    if (this.isRecording()) return Promise.resolve(null);
    if (!this.supported()) return Promise.reject(new Error('Recording needs MediaRecorder and IndexedDB.'));

    var ctx = this.engine.ensureContext();
    return DB.Mic.acquire().then(function (stream) {
      /* Channel count is forced here rather than in the capture constraints:
       * channelCount is only a hint to getUserMedia and devices routinely
       * ignore it, whereas an explicit count on the mix node decides what
       * MediaRecorder actually receives. */
      self._dest = ctx.createMediaStreamDestination();
      self._dest.channelCount = DB.Mic.stereo() ? 2 : 1;
      self._dest.channelCountMode = 'explicit';
      self._dest.channelInterpretation = 'speakers';
      self._micSource = ctx.createMediaStreamSource(stream);
      self._micSource.connect(self._dest);

      if (meta.includeClick !== false) {
        // A second tap off the master bus. The existing connection to the
        // speakers is untouched, so this changes nothing about what you hear.
        self._clickTap = ctx.createGain();
        self._clickTap.gain.value = 1;
        self.engine.masterGain.connect(self._clickTap);

        /* The click reaches the mix instantly while the playing arrives a
         * capture-buffer late, so without this the take has you dragging
         * behind a beat you were actually on. Delaying the click by the same
         * amount lines the two up. The figure is the browser's own estimate,
         * so it is a correction rather than a cure. */
        var latency = DB.Mic.inputLatency();
        if (latency > 0 && latency < 0.5) {
          self._clickDelay = ctx.createDelay(1);
          self._clickDelay.delayTime.value = latency;
          self._clickTap.connect(self._clickDelay);
          self._clickDelay.connect(self._dest);
        } else {
          self._clickTap.connect(self._dest);
        }
        self.appliedLatency = latency;
      }

      var mime = pickMime();
      self.recorder = mime ? new MediaRecorder(self._dest.stream, { mimeType: mime })
                           : new MediaRecorder(self._dest.stream);
      self.chunks = [];
      self.recorder.ondataavailable = function (e) {
        if (e.data && e.data.size) self.chunks.push(e.data);
      };
      self.startedAt = Date.now();
      self.meta = meta;
      self.recorder.start();
      return true;
    }).catch(function (e) {
      self._teardown();
      throw e;
    });
  };

  TakeRecorder.prototype.stop = function () {
    var self = this;
    if (!this.recorder) return Promise.resolve(null);
    if (this.recorder.state === 'inactive') { this._teardown(); return Promise.resolve(null); }

    return new Promise(function (resolve, reject) {
      var rec = self.recorder;
      rec.onstop = function () {
        var mime = rec.mimeType || 'audio/webm';
        var blob = new Blob(self.chunks, { type: mime });
        var ms = Date.now() - self.startedAt;
        self._teardown();

        if (!blob.size) return resolve(null);

        var take = {
          id: 't' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          sessionId: self.meta ? self.meta.sessionId : null,
          startedAt: self.startedAt,
          ms: ms,
          mime: mime,
          size: blob.size,
          ext: extensionFor(mime),
          alignedMs: Math.round((self.appliedLatency || 0) * 1000),
          channels: DB.Mic.stereo() ? 2 : 1,
          bpm: self.meta ? self.meta.bpm : null,
          meterLabel: self.meta ? self.meta.meterLabel : '',
          label: ''
        };
        DB.Takes.add(take, blob).then(function () { resolve(take); }).catch(reject);
      };
      rec.onerror = function (e) { self._teardown(); reject(e.error || new Error('recording failed')); };
      try { rec.stop(); } catch (e) { self._teardown(); reject(e); }
    });
  };

  TakeRecorder.prototype._teardown = function () {
    if (this._clickTap) {
      try { this.engine.masterGain.disconnect(this._clickTap); } catch (e) {}
      try { this._clickTap.disconnect(); } catch (e) {}
      this._clickTap = null;
    }
    if (this._clickDelay) { try { this._clickDelay.disconnect(); } catch (e) {} this._clickDelay = null; }
    if (this._micSource) { try { this._micSource.disconnect(); } catch (e) {} this._micSource = null; }
    if (this._dest) { try { this._dest.disconnect(); } catch (e) {} this._dest = null; }
    if (this.recorder) { this.recorder = null; DB.Mic.release(); }
    this.chunks = [];
  };

  DB.TakeRecorder = TakeRecorder;
  DB.takeMime = pickMime;
})(window.DrBeat = window.DrBeat || {});
