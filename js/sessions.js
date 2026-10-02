/* Practice log.
 *
 * A "session" is not one press of Start. Real practice is dozens of short runs
 * with thinking time between them, so runs are grouped into one session until
 * you leave it alone for longer than idleGapMs — then the next run opens a new
 * one. Each run is kept as a segment, so per-day totals stay correct even when
 * a session straddles midnight.
 *
 * Only aggregates are stored: times, tempi, counts. No audio (see takes.js).
 */
(function (DB) {
  'use strict';

  var KEY = 'drbeat21.sessions.v1';

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function write(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      return false;   // private mode or quota: keep running, just stop persisting
    }
  }

  function dayKey(ms) {
    var d = new Date(ms);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function PracticeLog(options) {
    options = options || {};
    this.now = options.now || function () { return Date.now(); };
    this.idleGapMs = options.idleGapMs || 5 * 60 * 1000;
    // Shorter than this and it was a stray tap, not practice.
    this.minSegmentMs = options.minSegmentMs === undefined ? 4000 : options.minSegmentMs;
    this.maxSessions = options.maxSessions || 500;

    this.session = null;    // the open session, if any
    this.segment = null;    // the run in progress, if any
    this.onChange = null;
  }

  PracticeLog.prototype.all = function () {
    return read().sort(function (a, b) { return b.startedAt - a.startedAt; });
  };

  PracticeLog.prototype.current = function () { return this.session; };
  PracticeLog.prototype.isRunning = function () { return !!this.segment; };

  /* Called when the metronome starts. */
  PracticeLog.prototype.beginSegment = function (info) {
    if (this.segment) this.endSegment();
    var now = this.now();

    if (this.session && (now - this.session.endedAt) > this.idleGapMs) this.session = null;
    if (!this.session) {
      this.session = {
        id: 's' + now + '-' + Math.random().toString(36).slice(2, 7),
        startedAt: now,
        endedAt: now,
        label: '',
        playMs: 0,
        beats: 0,
        bars: 0,
        bpmMin: null,
        bpmMax: null,
        coachModes: [],
        segments: [],
        timeCheck: null
      };
    }

    this.segment = {
      startedAt: now,
      ms: 0,
      beats: 0,
      bpmStart: info.bpm,
      bpmEnd: info.bpm,
      bpmMin: info.bpm,
      bpmMax: info.bpm,
      meter: info.meter,
      coach: info.coach || 'off',
      layers: (info.layers || []).slice()
    };
    this._emit();
    return this.session;
  };

  /* Called on every audible beat: the beat was heard, so it counts. */
  PracticeLog.prototype.countBeat = function (bpm) {
    var seg = this.segment;
    if (!seg) return;
    seg.beats++;
    if (typeof bpm === 'number') {
      seg.bpmEnd = bpm;
      if (seg.bpmMin === null || bpm < seg.bpmMin) seg.bpmMin = bpm;
      if (seg.bpmMax === null || bpm > seg.bpmMax) seg.bpmMax = bpm;
    }
  };

  /* Called when the metronome stops. Commits the run and persists the session. */
  PracticeLog.prototype.endSegment = function (extra) {
    var seg = this.segment;
    if (!seg) return null;
    this.segment = null;

    var now = this.now();
    seg.ms = Math.max(0, now - seg.startedAt);

    if (seg.ms < this.minSegmentMs) {
      // Too short to be practice. If it was the session's only run, drop the
      // session too rather than leaving an empty shell in the log.
      if (this.session && !this.session.segments.length) this.session = null;
      this._emit();
      return null;
    }

    var s = this.session;
    s.segments.push(seg);
    s.endedAt = now;
    s.playMs += seg.ms;
    s.beats += seg.beats;
    s.bars += seg.meter && seg.meter.beatsPerBar
      ? Math.floor(seg.beats / seg.meter.beatsPerBar) : 0;
    if (s.bpmMin === null || seg.bpmMin < s.bpmMin) s.bpmMin = seg.bpmMin;
    if (s.bpmMax === null || seg.bpmMax > s.bpmMax) s.bpmMax = seg.bpmMax;
    if (s.coachModes.indexOf(seg.coach) === -1) s.coachModes.push(seg.coach);
    if (extra && extra.timeCheck && extra.timeCheck.hits > 0) s.timeCheck = extra.timeCheck;

    this._persist(s);
    this._emit();
    return seg;
  };

  PracticeLog.prototype._persist = function (session) {
    var list = read();
    var i = list.findIndex(function (x) { return x.id === session.id; });
    var copy = JSON.parse(JSON.stringify(session));
    if (i >= 0) list[i] = copy; else list.push(copy);
    list.sort(function (a, b) { return b.startedAt - a.startedAt; });
    if (list.length > this.maxSessions) list = list.slice(0, this.maxSessions);
    write(list);
  };

  PracticeLog.prototype.setLabel = function (id, label) {
    var list = read();
    var entry = list.find(function (x) { return x.id === id; });
    if (entry) { entry.label = String(label).slice(0, 80); write(list); }
    if (this.session && this.session.id === id) this.session.label = String(label).slice(0, 80);
    this._emit();
  };

  PracticeLog.prototype.remove = function (id) {
    write(read().filter(function (x) { return x.id !== id; }));
    if (this.session && this.session.id === id) { this.session = null; this.segment = null; }
    this._emit();
  };

  PracticeLog.prototype.clear = function () {
    write([]);
    this.session = null;
    this.segment = null;
    this._emit();
  };

  PracticeLog.prototype.replaceAll = function (list) {
    write(Array.isArray(list) ? list : []);
    this._emit();
  };

  /* Totals, plus one bucket per day across the requested window. Segments are
   * bucketed by their own start, so a session running past midnight lands its
   * minutes on the days they were actually played. */
  PracticeLog.prototype.stats = function (days) {
    days = days || 14;
    var list = this.all();
    var byDay = {};
    var totalMs = 0, totalBeats = 0;

    list.forEach(function (s) {
      totalMs += s.playMs;
      totalBeats += s.beats;
      (s.segments || []).forEach(function (seg) {
        var k = dayKey(seg.startedAt);
        byDay[k] = (byDay[k] || 0) + seg.ms;
      });
    });

    // Include the run in progress so the chart moves while you practise.
    if (this.segment) {
      var live = Math.max(0, this.now() - this.segment.startedAt);
      var k = dayKey(this.segment.startedAt);
      byDay[k] = (byDay[k] || 0) + live;
      totalMs += live;
    }

    var series = [];
    var cursor = new Date(this.now());
    cursor.setHours(0, 0, 0, 0);
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(cursor.getTime() - i * 86400000);
      var key = dayKey(d.getTime());
      series.push({ day: key, date: d, ms: byDay[key] || 0 });
    }

    var weekAgo = this.now() - 7 * 86400000;
    var weekMs = 0;
    list.forEach(function (s) {
      (s.segments || []).forEach(function (seg) {
        if (seg.startedAt >= weekAgo) weekMs += seg.ms;
      });
    });

    var longest = list.reduce(function (best, s) {
      return (!best || s.playMs > best.playMs) ? s : best;
    }, null);

    // A day counts toward the streak only if something was actually played.
    var streak = 0;
    for (var j = series.length - 1; j >= 0; j--) {
      if (series[j].ms > 0) streak++; else break;
    }

    return {
      sessions: list.length,
      totalMs: totalMs,
      totalBeats: totalBeats,
      weekMs: weekMs,
      longestMs: longest ? longest.playMs : 0,
      streak: streak,
      series: series,
      maxMs: series.reduce(function (m, p) { return Math.max(m, p.ms); }, 0)
    };
  };

  PracticeLog.prototype.toCSV = function () {
    var rows = [[
      'started', 'ended', 'label', 'minutes', 'beats', 'bars',
      'bpm_min', 'bpm_max', 'coach_modes', 'runs',
      'timecheck_accuracy_pct', 'timecheck_avg_error_ms', 'timecheck_bias_ms'
    ]];
    this.all().forEach(function (s) {
      var tc = s.timeCheck;
      rows.push([
        new Date(s.startedAt).toISOString(),
        new Date(s.endedAt).toISOString(),
        s.label || '',
        (s.playMs / 60000).toFixed(2),
        s.beats, s.bars,
        s.bpmMin === null ? '' : s.bpmMin,
        s.bpmMax === null ? '' : s.bpmMax,
        (s.coachModes || []).join(' '),
        (s.segments || []).length,
        tc ? tc.accuracy : '',
        tc ? tc.avgAbsMs.toFixed(1) : '',
        tc ? tc.biasMs.toFixed(1) : ''
      ]);
    });
    return rows.map(function (r) {
      return r.map(function (cell) {
        var v = String(cell);
        // Quote anything that could otherwise break the column structure.
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\n');
  };

  PracticeLog.prototype._emit = function () { if (this.onChange) this.onChange(this); };

  DB.PracticeLog = PracticeLog;
  DB.dayKey = dayKey;
})(window.DrBeat = window.DrBeat || {});
