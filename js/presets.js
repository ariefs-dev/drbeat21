/* Memory slots — the DB-90 stores 50 setups; here they live in localStorage
 * and can be exported to a file so they survive a browser profile wipe. */
(function (DB) {
  'use strict';

  var KEY = 'drbeat21.presets.v1';
  var LAST = 'drbeat21.last.v1';

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false; // private mode / quota — the app keeps working, just forgets
    }
  }

  DB.Presets = {
    all: function () {
      var list = read(KEY, []);
      return Array.isArray(list) ? list : [];
    },
    save: function (name, state) {
      var list = this.all();
      var entry = { name: name, savedAt: Date.now(), state: state };
      var i = list.findIndex(function (p) { return p.name === name; });
      if (i >= 0) list[i] = entry; else list.push(entry);
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
      write(KEY, list);
      return list;
    },
    remove: function (name) {
      var list = this.all().filter(function (p) { return p.name !== name; });
      write(KEY, list);
      return list;
    },
    get: function (name) {
      return this.all().find(function (p) { return p.name === name; }) || null;
    },
    replaceAll: function (list) {
      write(KEY, list);
      return this.all();
    },
    rememberLast: function (state) { write(LAST, state); },
    recallLast: function () { return read(LAST, null); }
  };
})(window.DrBeat = window.DrBeat || {});
