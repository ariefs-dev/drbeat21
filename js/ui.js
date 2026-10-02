/* DOM wiring: turns the engine/coach/midi objects into the front panel. */
(function (DB) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var engine = new DB.Engine();
  var coach = new DB.Coach(engine);
  var midi = new DB.MidiClock(engine);

  var LAYERS = [
    { key: 'quarter',   label: 'Quarter',   note: '♩' },
    { key: 'eighth',    label: 'Eighth',    note: '♪♪' },
    { key: 'triplet',   label: 'Triplet',   note: '♪♪♪' },
    { key: 'sixteenth', label: 'Sixteenth', note: '♬♬' },
    { key: 'shuffle',   label: 'Shuffle',   note: '♪‧♪' }
  ];

  // Italian tempo markings, by the lower bound of each range.
  var TEMPO_NAMES = [
    [30, 'Grave'], [40, 'Largo'], [46, 'Lento'], [52, 'Adagio'], [56, 'Adagietto'],
    [60, 'Andante'], [76, 'Andantino'], [88, 'Moderato'], [108, 'Allegretto'],
    [120, 'Allegro'], [156, 'Vivace'], [176, 'Presto'], [200, 'Prestissimo']
  ];

  function tempoName(bpm) {
    var name = TEMPO_NAMES[0][1];
    for (var i = 0; i < TEMPO_NAMES.length; i++) {
      if (bpm >= TEMPO_NAMES[i][0]) name = TEMPO_NAMES[i][1];
    }
    return name;
  }

  /* ───────── Display ───────── */

  var ledEls = [];
  var startedAt = 0;
  var barsElapsed = 0;

  function buildLeds() {
    var wrap = $('leds');
    wrap.innerHTML = '';
    ledEls = [];
    var n = engine.beatsPerMeasure || 1;
    for (var i = 0; i < n; i++) {
      var el = document.createElement('span');
      el.className = 'led' + (engine.beatsPerMeasure && engine.accents[i] === 2 ? ' led-accent' : '') +
                     (engine.beatsPerMeasure && engine.accents[i] === 0 ? ' led-off' : '');
      wrap.appendChild(el);
      ledEls.push(el);
    }
  }

  function buildAccentGrid() {
    var wrap = $('accentGrid');
    wrap.innerHTML = '';
    if (engine.beatsPerMeasure === 0) {
      var p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No bar length set — every click is unaccented.';
      wrap.appendChild(p);
      return;
    }
    for (var i = 0; i < engine.beatsPerMeasure; i++) {
      (function (idx) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'accent-cell';
        b.dataset.index = idx;
        paintAccentCell(b, engine.accents[idx]);
        b.addEventListener('click', function () {
          // accent (2) -> normal (1) -> silent (0) -> accent
          var next = (engine.accents[idx] + 2) % 3;
          engine.accents[idx] = next;
          paintAccentCell(b, next);
          buildLeds();
          persist();
        });
        wrap.appendChild(b);
      })(i);
    }
  }

  function paintAccentCell(el, value) {
    el.classList.remove('is-accent', 'is-normal', 'is-silent');
    el.classList.add(value === 2 ? 'is-accent' : value === 1 ? 'is-normal' : 'is-silent');
    el.textContent = (parseInt(el.dataset.index, 10) + 1);
    el.setAttribute('aria-label',
      'Beat ' + (parseInt(el.dataset.index, 10) + 1) + ': ' +
      (value === 2 ? 'accented' : value === 1 ? 'normal' : 'silent'));
  }

  function refreshTempoDisplay() {
    $('bpmValue').textContent = engine.bpm;
    $('bpmSlider').value = engine.bpm;
    $('tempoName').textContent = tempoName(engine.bpm);
    $('grNow').textContent = engine.bpm + ' BPM';
  }

  function formatElapsed(sec) {
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  engine.onVisualBeat = function (info) {
    ledEls.forEach(function (el) { el.classList.remove('is-on'); });
    var el = ledEls[info.beatIndex];
    if (el) {
      el.classList.add('is-on');
      if (info.accent === 2) el.classList.add('is-accent-hit');
      setTimeout(function () { el.classList.remove('is-on', 'is-accent-hit'); },
        Math.min(140, engine.secondsPerBeat() * 700));
    }
    $('beatCount').textContent = engine.beatsPerMeasure ? (info.beatIndex + 1) : '–';
    $('barCount').textContent = info.barIndex + 1;
    $('elapsed').textContent = formatElapsed(engine.ctx.currentTime - startedAt);
    $('statusFlag').textContent = info.muted ? 'QUIET' : 'RUNNING';
    $('statusFlag').classList.toggle('is-quiet', !!info.muted);
    // Counted here rather than at schedule time: a beat queued but never heard
    // (because you stopped inside the lookahead window) was not practice.
    log.countBeat(engine.bpm);
  };

  engine.onBarScheduled = function (barIndex) {
    barsElapsed = barIndex;
    coach.onBar(barIndex);
    refreshTempoDisplay();
  };

  engine.onTickScheduled = function (tick, time) { midi.onTick(tick, time); };

  /* ───────── Transport ───────── */

  function setRunning(run) {
    if (run) {
      engine.ensureContext();
      startedAt = engine.ctx.currentTime;
      coach.reset();
      engine.start();
      midi.sendStart();
      log.beginSegment({
        bpm: engine.bpm,
        meter: { beatsPerBar: engine.beatsPerMeasure, beatUnit: engine.beatUnit, label: meterLabel() },
        coach: coach.mode,
        layers: activeLayers()
      });
      renderLive();
    } else {
      engine.stop();
      midi.sendStop();
      ledEls.forEach(function (el) { el.classList.remove('is-on', 'is-accent-hit'); });
      log.endSegment({ timeCheck: coach.mode === 'timecheck' ? coach.score() : null });
      renderLog();
    }
    var btn = $('startStop');
    btn.textContent = run ? 'Stop' : 'Start';
    btn.classList.toggle('is-running', run);
    btn.setAttribute('aria-pressed', String(run));
    $('statusFlag').textContent = run ? 'RUNNING' : 'STOPPED';
    $('statusFlag').classList.toggle('is-quiet', false);
    if (!run) { $('beatCount').textContent = '–'; }
  }

  $('startStop').addEventListener('click', function () { setRunning(!engine.isRunning); });

  /* Tap tempo: average the gaps between recent taps, dropping the history when
   * the player pauses so an old tap cannot drag the average. */
  var taps = [];
  function tap() {
    var now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];
    taps.push(now);
    if (taps.length > 6) taps.shift();
    if (taps.length < 2) { flashTap(); return; }
    var total = 0;
    for (var i = 1; i < taps.length; i++) total += taps[i] - taps[i - 1];
    var avg = total / (taps.length - 1);
    engine.setBpm(60000 / avg);
    refreshTempoDisplay();
    persist();
    flashTap();
  }
  function flashTap() {
    var b = $('tapTempo');
    b.classList.add('is-tapped');
    setTimeout(function () { b.classList.remove('is-tapped'); }, 110);
  }
  $('tapTempo').addEventListener('click', tap);

  /* ───────── Tempo controls ───────── */

  function nudge(delta) {
    engine.setBpm(engine.bpm + delta);
    refreshTempoDisplay();
    persist();
  }
  $('bpmUp').addEventListener('click', function () { nudge(1); });
  $('bpmDown').addEventListener('click', function () { nudge(-1); });
  $('bpmUp10').addEventListener('click', function () { nudge(10); });
  $('bpmDown10').addEventListener('click', function () { nudge(-10); });
  $('bpmSlider').addEventListener('input', function () {
    engine.setBpm(parseInt(this.value, 10));
    refreshTempoDisplay();
    persist();
  });
  $('tempoPresets').addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    engine.setBpm(parseInt(chip.dataset.bpm, 10));
    refreshTempoDisplay();
    persist();
  });

  /* ───────── Beat / meter ───────── */

  $('beatsPerMeasure').addEventListener('change', function () {
    engine.setBeatsPerMeasure(parseInt(this.value, 10));
    buildLeds();
    buildAccentGrid();
    persist();
  });
  $('beatUnit').addEventListener('change', function () {
    engine.beatUnit = parseInt(this.value, 10);
    persist();
  });
  $('accentPresets').addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    var pattern = chip.dataset.pattern.split(',').map(Number);
    engine.setBeatsPerMeasure(pattern.length);
    engine.accents = pattern;
    $('beatsPerMeasure').value = String(pattern.length);
    buildLeds();
    buildAccentGrid();
    persist();
  });

  /* ───────── Note mixer ───────── */

  function buildMixer() {
    var wrap = $('layerMixer');
    wrap.innerHTML = '';
    LAYERS.forEach(function (spec) {
      var layer = engine.layers[spec.key];
      var row = document.createElement('div');
      row.className = 'mixer-row';

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'layer-toggle' + (layer.on ? ' is-on' : '');
      toggle.innerHTML = '<span class="layer-note">' + spec.note + '</span>' +
                         '<span class="layer-name">' + spec.label + '</span>';
      toggle.setAttribute('aria-pressed', String(layer.on));
      toggle.addEventListener('click', function () {
        layer.on = !layer.on;
        toggle.classList.toggle('is-on', layer.on);
        toggle.setAttribute('aria-pressed', String(layer.on));
        persist();
      });

      var fader = document.createElement('input');
      fader.type = 'range';
      fader.className = 'fader';
      fader.min = 0; fader.max = 1; fader.step = 0.01;
      fader.value = layer.vol;
      fader.setAttribute('aria-label', spec.label + ' level');
      fader.addEventListener('input', function () {
        layer.vol = parseFloat(this.value);
        persist();
      });

      row.appendChild(toggle);
      row.appendChild(fader);
      wrap.appendChild(row);
    });
  }

  /* ───────── Sound ───────── */

  function buildVoices() {
    var sel = $('voice');
    sel.innerHTML = '';
    DB.Voices.names.forEach(function (name) {
      var o = document.createElement('option');
      o.value = name;
      o.textContent = name.charAt(0).toUpperCase() + name.slice(1);
      sel.appendChild(o);
    });
    sel.value = engine.voice;
  }

  $('voice').addEventListener('change', function () {
    engine.voice = this.value;
    // Audition the new voice so picking one is not blind.
    if (!engine.isRunning) {
      var ctx = engine.ensureContext();
      DB.Voices.play(ctx, engine.masterGain, ctx.currentTime + 0.02, 'accent', engine.voice, 1);
    }
    persist();
  });

  /* Reference tone: one oscillator held for as long as the button is engaged,
   * ramped rather than switched so it does not click on start or stop. */
  var refOsc = null, refGain = null;
  function refFrequency() {
    var semitone = parseInt($('refNote').value, 10);   // 0 = A
    var base = parseInt($('refTune').value, 10);
    return base * Math.pow(2, semitone / 12);
  }
  function toggleRefTone(on) {
    var ctx = engine.ensureContext();
    var btn = $('refToneBtn');
    if (on && !refOsc) {
      refGain = ctx.createGain();
      refGain.gain.setValueAtTime(0.0001, ctx.currentTime);
      refGain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.04);
      refGain.connect(engine.masterGain);
      refOsc = ctx.createOscillator();
      refOsc.type = 'sine';
      refOsc.frequency.value = refFrequency();
      refOsc.connect(refGain);
      refOsc.start();
    } else if (!on && refOsc) {
      var g = refGain, o = refOsc;
      refOsc = null; refGain = null;
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05);
      o.stop(ctx.currentTime + 0.08);
    }
    btn.classList.toggle('is-on', !!refOsc);
    btn.setAttribute('aria-pressed', String(!!refOsc));
  }
  $('refToneBtn').addEventListener('click', function () { toggleRefTone(!refOsc); });
  $('refTune').addEventListener('input', function () {
    $('refTuneValue').textContent = this.value;
    if (refOsc) refOsc.frequency.setTargetAtTime(refFrequency(), engine.ctx.currentTime, 0.01);
    persist();
  });
  $('refNote').addEventListener('change', function () {
    if (refOsc) refOsc.frequency.setTargetAtTime(refFrequency(), engine.ctx.currentTime, 0.01);
    persist();
  });

  $('volume').addEventListener('input', function () {
    engine.ensureContext();
    engine.setVolume(parseFloat(this.value));
    persist();
  });

  /* ───────── Rhythm coach ───────── */

  $('coachTabs').addEventListener('click', function (e) {
    var tab = e.target.closest('.tab');
    if (!tab) return;
    var mode = tab.dataset.mode;
    Array.prototype.forEach.call(this.querySelectorAll('.tab'), function (t) {
      var active = t === tab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
    Array.prototype.forEach.call(document.querySelectorAll('.coach-pane'), function (p) {
      p.classList.toggle('is-hidden', p.dataset.pane !== mode);
    });
    coach.setMode(mode);
    refreshTempoDisplay();
    persist();
  });

  function bindNumber(id, apply) {
    $(id).addEventListener('change', function () {
      var v = parseInt(this.value, 10);
      if (isNaN(v)) return;
      var min = parseInt(this.min, 10), max = parseInt(this.max, 10);
      v = Math.min(max, Math.max(min, v));
      this.value = v;
      apply(v);
      persist();
    });
  }

  bindNumber('qcPlay', function (v) { coach.quiet.playBars = v; });
  bindNumber('qcMute', function (v) { coach.quiet.muteBars = v; });
  bindNumber('qcMaxMute', function (v) { coach.quiet.maxMute = v; });
  $('qcGradual').addEventListener('change', function () { coach.quiet.gradual = this.checked; persist(); });

  bindNumber('grStart', function (v) {
    coach.gradual.startBpm = v;
    if (coach.mode === 'gradual' && !engine.isRunning) { engine.setBpm(v); refreshTempoDisplay(); }
  });
  bindNumber('grTarget', function (v) { coach.gradual.targetBpm = v; $('grGoal').textContent = v + ' BPM'; });
  bindNumber('grStep', function (v) { coach.gradual.stepBpm = v; });
  bindNumber('grEvery', function (v) { coach.gradual.everyBars = v; });
  $('grLoop').addEventListener('change', function () { coach.gradual.loop = this.checked; persist(); });

  $('tcGrid').addEventListener('change', function () { coach.timeCheck.grid = parseInt(this.value, 10); persist(); });
  $('tcTolerance').addEventListener('input', function () {
    coach.timeCheck.toleranceMs = parseInt(this.value, 10);
    $('tcToleranceValue').textContent = this.value;
    persist();
  });
  $('tcLatency').addEventListener('input', function () {
    coach.timeCheck.latencyMs = parseInt(this.value, 10);
    $('tcLatencyValue').textContent = this.value;
    persist();
  });
  $('tcThreshold').addEventListener('input', function () { coach.setThreshold(parseFloat(this.value)); persist(); });
  $('tcReset').addEventListener('click', function () { coach.resetScore(); $('tcVerdict').textContent = ' '; });

  $('tcListen').addEventListener('click', function () {
    var btn = this;
    var err = $('tcError');
    err.classList.add('is-hidden');
    if (coach.timeCheck.running) {
      coach.stopListening();
      btn.textContent = 'Enable microphone';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Requesting…';
    coach.startListening().then(function () {
      btn.disabled = false;
      btn.textContent = 'Stop listening';
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = 'Enable microphone';
      // Two different causes look identical here: an insecure origin, and an
      // embedded frame whose permissions policy withholds the microphone.
      err.textContent = 'Microphone unavailable: ' + (e && e.message ? e.message : e) +
        ' — Time Check needs mic access. Browsers grant it only on https:// or localhost, ' +
        'and an embedded copy of this page may be blocked from asking at all. ' +
        'Open it in its own tab, or run it locally, and try again.';
      err.classList.remove('is-hidden');
    });
  });

  coach.onUpdate = function (c) {
    if (c.mode === 'quiet') {
      $('qcState').textContent = engine.isRunning ? (engine.muted ? 'silent' : 'sounding') : 'idle';
      $('qcCycles').textContent = c.quiet.cycles;
      $('qcMute').value = c.quiet.muteBars;
    } else if (c.mode === 'gradual') {
      $('grGoal').textContent = c.gradual.targetBpm + ' BPM';
      $('grDone').textContent = c.gradual.done ? 'target reached' : '';
    } else if (c.mode === 'timecheck') {
      var s = c.score();
      $('tcHits').textContent = s.hits;
      $('tcAccuracy').textContent = s.hits ? s.accuracy + '%' : '–';
      $('tcAvg').textContent = s.hits ? s.avgAbsMs.toFixed(1) + ' ms' : '–';
      $('tcBias').textContent = s.hits
        ? (s.biasMs >= 0 ? '+' : '') + s.biasMs.toFixed(1) + ' ms ' + (s.biasMs >= 0 ? 'late' : 'early')
        : '–';
    }
  };

  coach.onHit = function (r) {
    var v = $('tcVerdict');
    v.textContent = r.verdict === 'good'
      ? 'On it (' + (r.deltaMs >= 0 ? '+' : '') + r.deltaMs.toFixed(0) + ' ms)'
      : r.verdict + ' by ' + Math.abs(r.deltaMs).toFixed(0) + ' ms';
    v.className = 'verdict is-' + r.verdict;
    // Needle spans ±120 ms across the track.
    var pct = Math.max(-1, Math.min(1, r.deltaMs / 120));
    $('tcNeedle').style.left = (50 + pct * 50) + '%';
  };

  // Mic level meter, only while Time Check is listening.
  (function meterLoop() {
    if (coach.timeCheck.running) {
      var pct = Math.min(100, coach.timeCheck.level * 250);
      $('tcMeter').style.width = pct + '%';
      $('tcMeter').classList.toggle('is-hot', coach.timeCheck.level > coach.timeCheck.threshold);
    } else if ($('tcMeter').style.width !== '0%') {
      $('tcMeter').style.width = '0%';
    }
    requestAnimationFrame(meterLoop);
  })();

  /* ───────── MIDI ───────── */

  $('midiEnable').addEventListener('change', function () {
    var box = this;
    if (!box.checked) { midi.enabled = false; midi.sendStop(); return; }
    if (!midi.supported()) {
      box.checked = false;
      $('midiStatus').textContent = 'This browser has no Web MIDI support (Chrome and Edge do; Safari and Firefox do not).';
      return;
    }
    midi.init().then(function () {
      midi.enabled = true;
      $('midiStatus').textContent = 'Connected. Pick an output to start sending clock.';
    }).catch(function (e) {
      box.checked = false;
      midi.enabled = false;
      $('midiStatus').textContent = 'MIDI access denied: ' + (e && e.message ? e.message : e);
    });
  });

  midi.onOutputs = function (list) {
    var sel = $('midiOut');
    var previous = sel.value;
    sel.innerHTML = '<option value="">— none —</option>';
    list.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name;
      sel.appendChild(opt);
    });
    sel.value = previous;
    if (!list.length) $('midiStatus').textContent = 'Connected, but no MIDI outputs were found.';
  };

  $('midiOut').addEventListener('change', function () {
    midi.selectOutput(this.value);
    $('midiStatus').textContent = this.value
      ? 'Sending clock to ' + this.options[this.selectedIndex].textContent + '.'
      : 'No output selected.';
  });

  /* ───────── State / presets ───────── */

  function snapshot() {
    return {
      bpm: engine.bpm,
      beatsPerMeasure: engine.beatsPerMeasure,
      beatUnit: engine.beatUnit,
      accents: engine.accents.slice(),
      voice: engine.voice,
      volume: engine.volume,
      layers: JSON.parse(JSON.stringify(engine.layers)),
      coachMode: coach.mode,
      quiet: JSON.parse(JSON.stringify(coach.quiet)),
      gradual: JSON.parse(JSON.stringify(coach.gradual)),
      timeCheck: {
        grid: coach.timeCheck.grid,
        toleranceMs: coach.timeCheck.toleranceMs,
        latencyMs: coach.timeCheck.latencyMs,
        threshold: coach.timeCheck.threshold
      },
      refNote: $('refNote').value,
      refTune: $('refTune').value
    };
  }

  function applyState(s) {
    if (!s) return;
    engine.setBpm(s.bpm || 120);
    engine.setBeatsPerMeasure(s.beatsPerMeasure === undefined ? 4 : s.beatsPerMeasure);
    if (Array.isArray(s.accents) && s.accents.length) engine.accents = s.accents.slice();
    engine.beatUnit = s.beatUnit || 4;
    engine.voice = DB.Voices.names.indexOf(s.voice) >= 0 ? s.voice : 'beep';
    engine.setVolume(typeof s.volume === 'number' ? s.volume : 0.8);
    if (s.layers) {
      Object.keys(engine.layers).forEach(function (k) {
        if (s.layers[k]) {
          engine.layers[k].on = !!s.layers[k].on;
          engine.layers[k].vol = typeof s.layers[k].vol === 'number' ? s.layers[k].vol : engine.layers[k].vol;
        }
      });
    }
    if (s.quiet) Object.assign(coach.quiet, s.quiet);
    if (s.gradual) Object.assign(coach.gradual, s.gradual);
    if (s.timeCheck) Object.assign(coach.timeCheck, s.timeCheck);

    // Push the restored values back into every control.
    $('beatsPerMeasure').value = String(engine.beatsPerMeasure);
    $('beatUnit').value = String(engine.beatUnit);
    $('volume').value = engine.volume;
    $('voice').value = engine.voice;
    $('qcPlay').value = coach.quiet.playBars;
    $('qcMute').value = coach.quiet.muteBars;
    $('qcMaxMute').value = coach.quiet.maxMute;
    $('qcGradual').checked = !!coach.quiet.gradual;
    $('grStart').value = coach.gradual.startBpm;
    $('grTarget').value = coach.gradual.targetBpm;
    $('grStep').value = coach.gradual.stepBpm;
    $('grEvery').value = coach.gradual.everyBars;
    $('grLoop').checked = !!coach.gradual.loop;
    $('tcGrid').value = String(coach.timeCheck.grid);
    $('tcTolerance').value = coach.timeCheck.toleranceMs;
    $('tcToleranceValue').textContent = coach.timeCheck.toleranceMs;
    $('tcLatency').value = coach.timeCheck.latencyMs;
    $('tcLatencyValue').textContent = coach.timeCheck.latencyMs;
    $('tcThreshold').value = coach.timeCheck.threshold;
    if (s.refNote !== undefined) $('refNote').value = s.refNote;
    if (s.refTune !== undefined) { $('refTune').value = s.refTune; $('refTuneValue').textContent = s.refTune; }

    var mode = s.coachMode || 'off';
    var tab = document.querySelector('.tab[data-mode="' + mode + '"]');
    if (tab) tab.click();

    buildLeds();
    buildAccentGrid();
    buildMixer();
    refreshTempoDisplay();
  }

  var persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () { DB.Presets.rememberLast(snapshot()); }, 250);
  }

  function renderPresets() {
    var ul = $('presetList');
    ul.innerHTML = '';
    var list = DB.Presets.all();
    if (!list.length) {
      var li = document.createElement('li');
      li.className = 'hint';
      li.textContent = 'No saved setups yet.';
      ul.appendChild(li);
      return;
    }
    list.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'preset-item';

      var name = document.createElement('span');
      name.className = 'preset-name';
      name.textContent = p.name;                       // textContent, never innerHTML
      var meta = document.createElement('span');
      meta.className = 'preset-meta';
      meta.textContent = p.state.bpm + ' BPM · ' + (p.state.beatsPerMeasure || 0) + '/' + (p.state.beatUnit || 4);

      var load = document.createElement('button');
      load.type = 'button';
      load.className = 'btn btn-xs';
      load.textContent = 'Load';
      load.addEventListener('click', function () {
        applyState(p.state);
        $('presetName').value = p.name;
        persist();
      });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-xs btn-danger';
      del.textContent = 'Delete';
      del.addEventListener('click', function () {
        DB.Presets.remove(p.name);
        renderPresets();
      });

      li.appendChild(name);
      li.appendChild(meta);
      li.appendChild(load);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  $('presetSave').addEventListener('click', function () {
    var name = $('presetName').value.trim();
    if (!name) { $('presetName').focus(); return; }
    DB.Presets.save(name, snapshot());
    renderPresets();
    presetStatus('Saved "' + name + '".');
  });

  function presetStatus(msg) { $('presetStatus').textContent = msg || ''; }

  /* Saving a file straight from the page only works when the page owns its tab.
   * A hosted copy runs inside a viewer that mediates saves itself and ignores
   * link-triggered downloads, so ask it first and fall back to the link. */
  function saveTextFile(filename, text, onDone) {
    function viaLink() {
      var type = /\.csv$/i.test(filename) ? 'text/csv' : 'application/json';
      var blob = new Blob([text], { type: type });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      onDone(null);
    }

    var host = (window.claude && typeof window.claude.use === 'function')
      ? window.claude.use('downloads') : null;
    if (!host) return viaLink();

    Promise.resolve(host).then(function (downloads) {
      if (!downloads) return viaLink();
      return downloads.save({ filename: filename, data: text })
        .then(function () { onDone(null); })
        .catch(function (e) {
          var code = e && e.code;
          if (code === 'declined') return onDone('cancelled');
          if (code === 'rate_limited') return onDone('busy');
          onDone('failed');
        });
    }).catch(function () { viaLink(); });
  }

  $('presetExport').addEventListener('click', function () {
    var list = DB.Presets.all();
    if (!list.length) { presetStatus('Nothing to export yet — save a setup first.'); return; }
    presetStatus('Exporting…');
    saveTextFile('drbeat21-presets.json', JSON.stringify(list, null, 2), function (problem) {
      if (problem === 'cancelled') return presetStatus('Export cancelled.');
      if (problem === 'busy') return presetStatus('Another save is already open — try again in a moment.');
      if (problem === 'failed') return presetStatus('Export failed. Open this page in its own tab and try again.');
      presetStatus('Exported ' + list.length + (list.length === 1 ? ' setup.' : ' setups.'));
    });
  });

  $('presetImport').addEventListener('click', function () { $('presetFile').click(); });
  $('presetFile').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var list = JSON.parse(reader.result);
        if (!Array.isArray(list)) throw new Error('expected a list of presets');
        // Keep only entries shaped like presets — an imported file is untrusted.
        var clean = list.filter(function (p) {
          return p && typeof p.name === 'string' && p.state && typeof p.state === 'object';
        });
        DB.Presets.replaceAll(clean);
        renderPresets();
        presetStatus('Imported ' + clean.length + (clean.length === 1 ? ' setup.' : ' setups.'));
      } catch (e) {
        presetStatus('That file could not be read as a preset export.');
      }
    };
    reader.readAsText(file);
    this.value = '';
  });

  /* ───────── Practice log ───────── */

  var log = new DB.PracticeLog();
  var recorder = new DB.TakeRecorder(engine);
  var allTakes = [];
  var chartView = 'chart';
  var openSession = null;   // id of the expanded session row

  function fmtDuration(ms) {
    var total = Math.round(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h) return h + 'h ' + m + 'm';
    if (m >= 10 || (m && !s)) return m + 'm';
    if (m) return m + 'm ' + s + 's';
    return s + 's';
  }
  function fmtShort(ms) {
    // Rounding straight to minutes shows "0m" immediately after a real run,
    // which reads as "nothing logged" exactly when you just practised.
    if (ms > 0 && ms < 60000) return Math.max(1, Math.round(ms / 1000)) + 's';
    var m = Math.round(ms / 60000);
    return m >= 60 ? (ms / 3600000).toFixed(1) + 'h' : m + 'm';
  }
  function fmtClock(ms) {
    var t = Math.floor(ms / 1000);
    return Math.floor(t / 60) + ':' + (t % 60 < 10 ? '0' : '') + (t % 60);
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function meterLabel() { return (engine.beatsPerMeasure || 0) + '/' + engine.beatUnit; }
  function activeLayers() {
    return Object.keys(engine.layers).filter(function (k) { return engine.layers[k].on; });
  }
  function logStatus(msg) { $('logStatus').textContent = msg || ''; }

  /* ── 14-day chart ──
   * One series, so no legend — the heading names it. Bars get a hover/focus
   * tooltip, and the table view below is the same numbers for non-visual reading. */
  function renderChart(stats) {
    var host = $('practiceChart');
    var W = 100, H = 34, PAD_B = 7;
    var plotH = H - PAD_B;
    var n = stats.series.length;
    var slot = W / n;
    var barW = Math.max(1.4, slot * 0.58);     // thin marks; the rest of the slot is surface
    var max = Math.max(stats.maxMs, 60000);    // one short day must not fill the plot
    var todayKey = DB.dayKey(Date.now());
    var p = [];

    p.push('<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" class="chart-svg" ' +
           'role="img" aria-label="Minutes practised per day, last 14 days">');
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      var y = (plotH - plotH * f).toFixed(2);
      p.push('<line class="grid" x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '"/>');
    });
    p.push('<line class="axis" x1="0" y1="' + plotH + '" x2="' + W + '" y2="' + plotH + '"/>');

    stats.series.forEach(function (d, i) {
      var x = (i * slot + (slot - barW) / 2).toFixed(2);
      var h = d.ms > 0 ? Math.max(0.9, (d.ms / max) * plotH) : 0;
      var cls = 'bar' + (d.day === todayKey ? ' is-today' : '');
      if (h > 0) {
        // Rounded top, square foot: the second rect re-squares the bottom
        // corners so the bar sits flat on the axis instead of floating.
        p.push('<rect class="' + cls + '" x="' + x + '" y="' + (plotH - h).toFixed(2) +
               '" width="' + barW.toFixed(2) + '" height="' + h.toFixed(2) + '" rx="0.9"/>');
        p.push('<rect class="' + cls + '" x="' + x + '" y="' + (plotH - Math.min(h, 1.2)).toFixed(2) +
               '" width="' + barW.toFixed(2) + '" height="' + Math.min(h, 1.2).toFixed(2) + '"/>');
      }
      // Full-height target so a one-minute day is still easy to hit.
      p.push('<rect class="hit" x="' + (i * slot).toFixed(2) + '" y="0" width="' + slot.toFixed(2) +
             '" height="' + plotH + '" tabindex="0" data-i="' + i + '"><title>' +
             d.date.toDateString() + ': ' + Math.round(d.ms / 60000) + ' min</title></rect>');
    });
    p.push('</svg><div class="chart-ticks">');
    stats.series.forEach(function (d, i) {
      var show = (n - 1 - i) % 2 === 0;
      p.push('<span>' + (show ? d.date.toLocaleDateString(undefined, { weekday: 'narrow' }) : '') + '</span>');
    });
    p.push('</div>');

    var peak = -1, peakI = -1;
    stats.series.forEach(function (d, i) { if (d.ms > peak) { peak = d.ms; peakI = i; } });
    if (peak > 0) {
      // Positioned against the plot, not the whole card: the ticks and padding
      // below are not part of the value scale, and measuring from the bottom of
      // the card pushed this label up out of the chart and into the toggle.
      var peakH = Math.max(0.9, (peak / max) * plotH);
      var topPct = ((plotH - peakH) / H) * 100;
      p.push('<span class="chart-peak" style="left:' + (((peakI + 0.5) / n) * 100).toFixed(2) +
             '%;top:calc(' + topPct.toFixed(2) + '% * var(--plot-h) / 100%)">' +
             fmtDuration(peak) + '</span>');
    }
    p.push('<div id="chartTip" class="chart-tip" hidden></div>');
    host.innerHTML = p.join('');

    var tip = $('chartTip');
    function show(i, el) {
      var d = stats.series[i];
      tip.innerHTML = '<b>' + d.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
                      '</b>' + (d.ms > 0 ? fmtDuration(d.ms) : 'nothing played');
      tip.hidden = false;
      var b = el.getBoundingClientRect(), hb = host.getBoundingClientRect();
      tip.style.left = Math.min(Math.max(b.left - hb.left + b.width / 2, 52), hb.width - 52) + 'px';
    }
    Array.prototype.forEach.call(host.querySelectorAll('.hit'), function (el) {
      var i = parseInt(el.dataset.i, 10);
      ['mouseenter', 'focus'].forEach(function (ev) { el.addEventListener(ev, function () { show(i, el); }); });
      ['mouseleave', 'blur'].forEach(function (ev) { el.addEventListener(ev, function () { tip.hidden = true; }); });
    });
  }

  function renderChartTable(stats) {
    var rows = stats.series.slice().reverse().map(function (d) {
      return '<tr><th scope="row">' +
        d.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
        '</th><td>' + (d.ms > 0 ? fmtDuration(d.ms) : '—') + '</td></tr>';
    }).join('');
    $('practiceTable').innerHTML =
      '<table><thead><tr><th scope="col">Day</th><th scope="col">Played</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  /* ── Session list ── */

  function takesFor(id) {
    return allTakes.filter(function (t) { return t.sessionId === id; });
  }

  function sessionRow(s, isLive) {
    var li = document.createElement('li');
    li.className = 'session-item' + (isLive ? ' is-live' : '');

    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'session-head';
    head.setAttribute('aria-expanded', String(openSession === s.id));

    var when = new Date(s.startedAt);
    var takes = takesFor(s.id);
    var bits = [fmtDuration(s.playMs)];
    if (s.bpmMin !== null) {
      bits.push(s.bpmMin === s.bpmMax ? s.bpmMin + ' BPM' : s.bpmMin + '–' + s.bpmMax + ' BPM');
    }
    if (s.beats) bits.push(s.beats.toLocaleString() + ' beats');
    if (takes.length) bits.push(takes.length + (takes.length === 1 ? ' take' : ' takes'));

    var title = document.createElement('span');
    title.className = 'session-when';
    title.textContent = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' · ' + when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    var meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = bits.join(' · ');

    var name = document.createElement('span');
    name.className = 'session-label';
    name.textContent = s.label || '';

    head.appendChild(title);
    head.appendChild(meta);
    if (s.label) head.appendChild(name);
    head.addEventListener('click', function () {
      openSession = openSession === s.id ? null : s.id;
      renderSessions();
    });
    li.appendChild(head);

    if (openSession !== s.id) return li;

    var body = document.createElement('div');
    body.className = 'session-body';

    var labelRow = document.createElement('div');
    labelRow.className = 'field-row';
    var lbl = document.createElement('label');
    lbl.textContent = 'What were you working on?';
    lbl.setAttribute('for', 'label-' + s.id);
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'label-' + s.id;
    input.maxLength = 80;
    input.value = s.label || '';
    input.placeholder = 'e.g. Etude no.3, bars 24–40';
    input.addEventListener('change', function () {
      log.setLabel(s.id, input.value);
      renderLog();
    });
    labelRow.appendChild(lbl);
    labelRow.appendChild(input);
    body.appendChild(labelRow);

    var facts = document.createElement('div');
    facts.className = 'readout';
    var coach = (s.coachModes || []).filter(function (m) { return m !== 'off'; });
    facts.innerHTML =
      '<span>Runs <b>' + (s.segments || []).length + '</b></span>' +
      '<span>Bars <b>' + s.bars.toLocaleString() + '</b></span>' +
      (coach.length ? '<span>Coach <b>' + coach.join(', ') + '</b></span>' : '') +
      (s.timeCheck ? '<span>Time Check <b>' + s.timeCheck.accuracy + '% · ' +
        s.timeCheck.avgAbsMs.toFixed(0) + 'ms</b></span>' : '');
    body.appendChild(facts);

    if (takes.length) {
      var tl = document.createElement('div');
      tl.className = 'take-list';
      takes.forEach(function (t) { tl.appendChild(takeRow(t)); });
      body.appendChild(tl);
    }

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-xs btn-danger';
    del.textContent = 'Delete session';
    del.addEventListener('click', function () {
      var ts = takesFor(s.id);
      Promise.all(ts.map(function (t) { return DB.Takes.remove(t.id); }))
        .catch(function () {})
        .then(function () {
          log.remove(s.id);
          return refreshTakes();
        })
        .then(function () {
          logStatus('Session deleted' + (ts.length ? ' with ' + ts.length + ' take(s).' : '.'));
          renderLog();
        });
    });
    body.appendChild(del);
    li.appendChild(body);
    return li;
  }

  function takeRow(t) {
    var row = document.createElement('div');
    row.className = 'take';

    var info = document.createElement('span');
    info.className = 'take-info';
    info.textContent = new Date(t.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) +
      ' · ' + fmtClock(t.ms) + ' · ' + fmtBytes(t.size) + (t.bpm ? ' · ' + t.bpm + ' BPM' : '');

    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn btn-xs';
    play.textContent = 'Play';
    play.addEventListener('click', function () {
      if (row.querySelector('audio')) { row.querySelector('audio').remove(); play.textContent = 'Play'; return; }
      DB.Takes.blob(t.id).then(function (blob) {
        if (!blob) return logStatus('That take could not be found.');
        var audio = document.createElement('audio');
        audio.controls = true;
        audio.className = 'take-audio';
        audio.src = URL.createObjectURL(blob);
        // Revoke when the element goes away, not on a timer: the player needs
        // the URL for as long as it is on screen.
        audio.addEventListener('emptied', function () { URL.revokeObjectURL(audio.src); });
        row.appendChild(audio);
        play.textContent = 'Close';
        audio.play().catch(function () {});
      });
    });

    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-xs';
    save.textContent = 'Save';
    save.addEventListener('click', function () {
      DB.Takes.blob(t.id).then(function (blob) {
        if (!blob) return logStatus('That take could not be found.');
        var stamp = new Date(t.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
        saveBlobFile('drbeat21-take-' + stamp + '.' + t.ext, blob, function (problem) {
          if (problem === 'cancelled') return logStatus('Save cancelled.');
          if (problem) return logStatus('Could not save that take.');
          logStatus('Take saved.');
        });
      });
    });

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-xs btn-danger';
    del.textContent = 'Delete';
    del.addEventListener('click', function () {
      DB.Takes.remove(t.id).then(refreshTakes).then(function () {
        logStatus('Take deleted.');
        renderLog();
      });
    });

    row.appendChild(info);
    row.appendChild(play);
    row.appendChild(save);
    row.appendChild(del);
    return row;
  }

  function renderSessions() {
    var ul = $('sessionList');
    ul.innerHTML = '';
    var live = log.current();
    var stored = log.all().filter(function (s) { return !live || s.id !== live.id; });
    var rows = (live ? [live] : []).concat(stored);

    // A take can be recorded without the metronome ever running, and a session
    // can be deleted out from under one. Either way the audio still exists, so
    // it gets its own group rather than silently vanishing from the list.
    var known = {};
    rows.forEach(function (s) { known[s.id] = true; });
    var orphans = allTakes.filter(function (t) { return !t.sessionId || !known[t.sessionId]; });

    if (!rows.length && !orphans.length) {
      var li = document.createElement('li');
      li.className = 'hint';
      li.textContent = 'No sessions yet. Press Start and the log begins on its own.';
      ul.appendChild(li);
      return;
    }

    if (orphans.length) {
      var oli = document.createElement('li');
      oli.className = 'session-item';
      var oh = document.createElement('div');
      oh.className = 'session-head is-static';
      oh.innerHTML = '<span class="session-when">Takes without a session</span>' +
                     '<span class="session-meta">' + orphans.length +
                     (orphans.length === 1 ? ' take' : ' takes') + '</span>';
      oli.appendChild(oh);
      var ob = document.createElement('div');
      ob.className = 'session-body';
      var otl = document.createElement('div');
      otl.className = 'take-list';
      orphans.forEach(function (t) { otl.appendChild(takeRow(t)); });
      ob.appendChild(otl);
      oli.appendChild(ob);
      ul.appendChild(oli);
    }

    rows.slice(0, 40).forEach(function (s) {
      ul.appendChild(sessionRow(s, !!live && s.id === live.id));
    });
  }

  function renderLog() {
    var stats = log.stats(14);
    $('statWeek').textContent = fmtShort(stats.weekMs);
    $('statStreak').textContent = stats.streak + (stats.streak === 1 ? ' day' : ' days');
    $('statSessions').textContent = stats.sessions;
    $('statBeats').textContent = stats.totalBeats.toLocaleString();
    renderChart(stats);
    renderChartTable(stats);
    renderSessions();
  }

  function renderLive() {
    var el = $('logLive');
    var s = log.current();
    if (!log.isRunning() || !s) {
      el.classList.add('is-idle');
      el.textContent = s
        ? 'Session paused — ' + fmtDuration(s.playMs) + ' logged. Start again within 5 minutes to continue it.'
        : 'Not practising — the log starts itself when you hit Start.';
      return;
    }
    el.classList.remove('is-idle');
    var liveMs = s.playMs + (Date.now() - log.segment.startedAt);
    el.textContent = 'Practising — ' + fmtDuration(liveMs) + ' · ' +
      (s.beats + log.segment.beats).toLocaleString() + ' beats · ' + engine.bpm + ' BPM';
  }

  function refreshTakes() {
    if (!DB.Takes.supported()) { allTakes = []; return Promise.resolve(); }
    return DB.Takes.list().then(function (rows) { allTakes = rows; })
      .catch(function () { allTakes = []; });
  }

  /* ── Recording ── */

  function setRecordUi(on) {
    var btn = $('recordBtn');
    btn.classList.toggle('is-recording', on);
    btn.setAttribute('aria-pressed', String(on));
    $('recordLabel').textContent = on ? 'Stop' : 'Record';
    $('recTime').hidden = !on;
  }

  $('recordBtn').addEventListener('click', function () {
    var btn = this;
    if (recorder.isRecording()) {
      btn.disabled = true;
      recorder.stop().then(function (take) {
        btn.disabled = false;
        setRecordUi(false);
        if (!take) { logStatus('Nothing was recorded.'); return refreshTakes().then(renderLog); }
        openSession = take.sessionId || openSession;
        return refreshTakes().then(function () {
          logStatus('Take saved — ' + fmtClock(take.ms) + ', ' + fmtBytes(take.size) + '.');
          renderLog();
        });
      }).catch(function (e) {
        btn.disabled = false;
        setRecordUi(false);
        logStatus('Recording failed: ' + (e && e.message ? e.message : e));
      });
      return;
    }

    if (!recorder.supported()) {
      logStatus('This browser cannot record audio (needs MediaRecorder and IndexedDB).');
      return;
    }
    btn.disabled = true;
    logStatus('Starting…');
    var session = log.current();
    recorder.start({
      sessionId: session ? session.id : null,
      bpm: engine.bpm,
      meterLabel: meterLabel(),
      includeClick: $('includeClick').checked
    }).then(function () {
      btn.disabled = false;
      setRecordUi(true);
      logStatus('Recording. Takes stay in this browser.');
    }).catch(function (e) {
      btn.disabled = false;
      setRecordUi(false);
      logStatus('Microphone unavailable: ' + (e && e.message ? e.message : e) +
        ' — recording needs mic access, granted only on https:// or localhost, ' +
        'and an embedded copy of this page may be blocked from asking.');
    });
  });

  /* ── Export ── */

  function saveBlobFile(filename, blob, onDone) {
    var host = (window.claude && typeof window.claude.use === 'function')
      ? window.claude.use('downloads') : null;
    function viaLink() {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      onDone(null);
    }
    if (!host) return viaLink();
    Promise.resolve(host).then(function (downloads) {
      if (!downloads) return viaLink();
      return downloads.save({ filename: filename, data: blob })
        .then(function () { onDone(null); })
        .catch(function (e) { onDone(e && e.code === 'declined' ? 'cancelled' : 'failed'); });
    }).catch(function () { viaLink(); });
  }

  $('logExportCsv').addEventListener('click', function () {
    if (!log.all().length) return logStatus('No sessions to export yet.');
    saveTextFile('drbeat21-practice.csv', log.toCSV(), function (problem) {
      logStatus(problem === 'cancelled' ? 'Export cancelled.'
        : problem ? 'Export failed.' : 'Practice log exported as CSV.');
    });
  });

  $('logExportJson').addEventListener('click', function () {
    var list = log.all();
    if (!list.length) return logStatus('No sessions to export yet.');
    saveTextFile('drbeat21-practice.json', JSON.stringify(list, null, 2), function (problem) {
      logStatus(problem === 'cancelled' ? 'Export cancelled.'
        : problem ? 'Export failed.' : 'Practice log exported as JSON.');
    });
  });

  $('logClear').addEventListener('click', function () {
    var btn = this;
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Clear log — tap again';
      logStatus('This deletes every logged session and every recorded take.');
      setTimeout(function () {
        btn.dataset.armed = '0';
        btn.textContent = 'Clear log';
      }, 5000);
      return;
    }
    btn.dataset.armed = '0';
    btn.textContent = 'Clear log';
    log.clear();
    DB.Takes.clear().catch(function () {}).then(refreshTakes).then(function () {
      openSession = null;
      logStatus('Practice log and takes cleared.');
      renderLog();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (btn) {
    btn.addEventListener('click', function () {
      chartView = btn.dataset.view;
      Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
        var on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      $('practiceChart').classList.toggle('is-hidden', chartView !== 'chart');
      $('practiceTable').classList.toggle('is-hidden', chartView !== 'table');
    });
  });

  log.onChange = function () { renderLive(); };

  // One ticker drives both live readouts; nothing here touches the audio clock.
  setInterval(function () {
    if (log.isRunning()) renderLive();
    if (recorder.isRecording()) $('recTime').textContent = fmtClock(recorder.elapsedMs());
  }, 500);

  /* ───────── Audio routing ───────── */

  var ioMeterRaf = null;
  var ioProbe = null;   // { source, analyser, data } while Check input is on

  function ioStatus(msg) { $('ioStatus').textContent = msg || ''; }

  function fillDeviceLists() {
    return DB.Mic.devices().then(function (d) {
      var inSel = $('inputDevice'), outSel = $('outputDevice');
      var prevIn = DB.Mic.device(), prevOut = outSel.value;

      inSel.innerHTML = '<option value="">Default input</option>';
      d.inputs.forEach(function (dev, i) {
        if (dev.deviceId === 'default') return;   // already covered by the first entry
        var o = document.createElement('option');
        o.value = dev.deviceId;
        o.textContent = dev.label || ('Input ' + (i + 1));
        inSel.appendChild(o);
      });
      inSel.value = prevIn;
      // An unknown stored id means that interface is unplugged right now.
      if (inSel.value !== prevIn) inSel.value = '';

      var canRoute = typeof engine.ensureContext === 'function';
      outSel.innerHTML = '<option value="">Default output</option>';
      d.outputs.forEach(function (dev, i) {
        if (dev.deviceId === 'default') return;
        var o = document.createElement('option');
        o.value = dev.deviceId;
        o.textContent = dev.label || ('Output ' + (i + 1));
        outSel.appendChild(o);
      });
      outSel.value = prevOut;

      if (!d.labelled && d.inputs.length) {
        ioStatus('Device names appear once you have allowed the microphone — press Check input.');
      }
      return d;
    });
  }

  // Output routing is Chromium-only; elsewhere the control would lie, so hide it.
  (function gateOutputRouting() {
    var supported = typeof AudioContext !== 'undefined' &&
      typeof AudioContext.prototype.setSinkId === 'function';
    if (supported) return;
    var sel = $('outputDevice');
    sel.disabled = true;
    var row = sel.closest('.field-row');
    if (row) row.classList.add('is-unsupported');
    sel.title = 'This browser cannot choose an output device.';
  })();

  $('inputDevice').addEventListener('change', function () {
    var result = DB.Mic.setDevice(this.value);
    var name = this.options[this.selectedIndex].textContent;
    stopInputCheck();
    if (result.restartNeeded) {
      // The worklet and recorder are wired to the old source node, so they
      // cannot simply follow the stream to a different device.
      if (coach.timeCheck.running) { coach.stopListening(); $('tcListen').textContent = 'Enable microphone'; }
      if (recorder.isRecording()) {
        recorder.stop().then(function () { setRecordUi(false); return refreshTakes(); }).then(renderLog);
      }
      ioStatus('Input switched to ' + name + '. Listening and recording were stopped — start them again.');
    } else {
      ioStatus('Input set to ' + name + '.');
    }
    persist();
  });

  $('stereoIn').addEventListener('change', function () {
    var result = DB.Mic.setStereo(this.checked);
    stopInputCheck();
    if (result.restartNeeded && coach.timeCheck.running) {
      coach.stopListening();
      $('tcListen').textContent = 'Enable microphone';
    }
    ioStatus(this.checked
      ? 'Takes will capture both channels when the input offers them.'
      : 'Takes will capture one channel.');
    persist();
  });

  $('outputDevice').addEventListener('change', function () {
    var ctx = engine.ensureContext();
    var id = this.value;
    var name = this.options[this.selectedIndex].textContent;
    if (typeof ctx.setSinkId !== 'function') return ioStatus('This browser cannot choose an output device.');
    ctx.setSinkId(id).then(function () {
      ioStatus('Click is going to ' + name + '.');
    }).catch(function (e) {
      ioStatus('Could not switch output: ' + (e && e.message ? e.message : e));
    });
    persist();
  });

  function stopInputCheck() {
    if (ioMeterRaf) { cancelAnimationFrame(ioMeterRaf); ioMeterRaf = null; }
    if (ioProbe) {
      try { ioProbe.source.disconnect(); } catch (e) {}
      ioProbe = null;
      DB.Mic.release();
    }
    $('inputMeter').style.width = '0%';
    $('inputMeter').classList.remove('is-hot');
    var btn = $('checkInput');
    btn.classList.remove('is-on');
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = 'Check input';
  }

  $('checkInput').addEventListener('click', function () {
    var btn = this;
    if (ioProbe) { stopInputCheck(); ioStatus('Input check stopped.'); return; }

    btn.disabled = true;
    ioStatus('Opening input…');
    var ctx = engine.ensureContext();
    DB.Mic.acquire().then(function (stream) {
      btn.disabled = false;
      var source = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      // Deliberately not connected to the destination: monitoring the input
      // through the speakers is a feedback loop waiting to happen.
      ioProbe = { source: source, analyser: analyser, data: new Float32Array(analyser.fftSize) };

      btn.classList.add('is-on');
      btn.setAttribute('aria-pressed', 'true');
      btn.textContent = 'Stop check';

      var st = DB.Mic.settings() || {};
      var latency = Math.round(DB.Mic.inputLatency() * 1000);
      ioStatus('Listening — ' + (st.channelCount || 1) + ' channel' + ((st.channelCount || 1) > 1 ? 's' : '') +
        ' at ' + (st.sampleRate || engine.ctx.sampleRate) + ' Hz' +
        (latency ? ', ' + latency + ' ms input latency' : '') +
        '. Play something and watch the meter.');
      fillDeviceLists();

      (function loop() {
        if (!ioProbe) return;
        ioProbe.analyser.getFloatTimeDomainData(ioProbe.data);
        var peak = 0;
        for (var i = 0; i < ioProbe.data.length; i++) {
          var v = Math.abs(ioProbe.data[i]);
          if (v > peak) peak = v;
        }
        var bar = $('inputMeter');
        bar.style.width = Math.min(100, peak * 140) + '%';
        bar.classList.toggle('is-hot', peak > 0.02);
        ioMeterRaf = requestAnimationFrame(loop);
      })();
    }).catch(function (e) {
      btn.disabled = false;
      stopInputCheck();
      ioStatus('Could not open that input: ' + (e && e.message ? e.message : e));
    });
  });

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    // Plugging the interface in after load should not require a page reload.
    navigator.mediaDevices.addEventListener('devicechange', function () {
      fillDeviceLists().then(function () { ioStatus('Audio devices changed.'); });
    });
  }

  $('stereoIn').checked = DB.Mic.stereo();
  fillDeviceLists();

  /* ───────── Keyboard ───────── */

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
      if (!(e.code === 'Space' && t.type === 'range')) return;
    }
    if (e.code === 'Space') { e.preventDefault(); setRunning(!engine.isRunning); }
    else if (e.code === 'ArrowUp') { e.preventDefault(); nudge(e.shiftKey ? 10 : 1); }
    else if (e.code === 'ArrowDown') { e.preventDefault(); nudge(e.shiftKey ? -10 : -1); }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); tap(); }
  });

  /* ───────── Boot ───────── */

  buildVoices();
  buildMixer();
  buildLeds();
  buildAccentGrid();
  refreshTempoDisplay();
  renderPresets();
  renderLog();
  renderLive();
  refreshTakes().then(renderLog);
  applyState(DB.Presets.recallLast());
  $('grGoal').textContent = coach.gradual.targetBpm + ' BPM';

  // Browsers refuse to start audio before a gesture; warm the context on the first one.
  ['pointerdown', 'keydown'].forEach(function (evt) {
    document.addEventListener(evt, function once() {
      engine.ensureContext();
      document.removeEventListener(evt, once);
    });
  });

  DB.app = { engine: engine, coach: coach, midi: midi, log: log, recorder: recorder };
})(window.DrBeat = window.DrBeat || {});
