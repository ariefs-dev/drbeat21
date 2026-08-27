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
    } else {
      engine.stop();
      midi.sendStop();
      ledEls.forEach(function (el) { el.classList.remove('is-on', 'is-accent-hit'); });
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
      var blob = new Blob([text], { type: 'application/json' });
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
  applyState(DB.Presets.recallLast());
  $('grGoal').textContent = coach.gradual.targetBpm + ' BPM';

  // Browsers refuse to start audio before a gesture; warm the context on the first one.
  ['pointerdown', 'keydown'].forEach(function (evt) {
    document.addEventListener(evt, function once() {
      engine.ensureContext();
      document.removeEventListener(evt, once);
    });
  });

  DB.app = { engine: engine, coach: coach, midi: midi };
})(window.DrBeat = window.DrBeat || {});
