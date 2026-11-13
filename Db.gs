/**
 * Db.gs — tiny "database" layer on top of Google Sheets.
 * Each table is a sheet whose first row holds the column headers defined in SCHEMA.
 */

var Db = (function () {
  var _ss = null;
  var _cache = {};

  function ss() {
    if (!_ss) _ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!_ss) throw new Error('Spreadsheet not found. This script must be bound to the Google Sheet (Extensions > Apps Script).');
    return _ss;
  }

  var _healed = false;
  function sheet(name) {
    var sh = ss().getSheetByName(name);
    if (!sh && !_healed && SCHEMA[name]) {
      // Self-heal: create any missing tabs (same as running setup) the first time one is needed.
      _healed = true;
      setup();
      sh = ss().getSheetByName(name);
    }
    if (!sh) {
      throw new Error('Sheet "' + name + '" is missing in spreadsheet "' + ss().getName() + '". Run setup() from the Apps Script editor (or Hotel menu > Setup).');
    }
    return sh;
  }

  function tz() {
    return Session.getScriptTimeZone() || 'Asia/Kolkata';
  }

  function fromCell(table, field, v) {
    if ((NUMERIC[table] || []).indexOf(field) !== -1) {
      if (v === '' || v === null) return 0;
      var n = Number(v);
      return isNaN(n) ? 0 : n;
    }
    if ((BOOLEAN[table] || []).indexOf(field) !== -1) {
      return v === true || String(v).toUpperCase() === 'TRUE';
    }
    if (v instanceof Date) {
      var hasTime = v.getHours() || v.getMinutes();
      return Utilities.formatDate(v, tz(), hasTime ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
    }
    return v === null || v === undefined ? '' : String(v);
  }

  function toCell(table, field, v) {
    if (v === undefined || v === null) return '';
    if ((NUMERIC[table] || []).indexOf(field) !== -1) {
      var n = Number(v);
      return isNaN(n) ? 0 : n;
    }
    if ((BOOLEAN[table] || []).indexOf(field) !== -1) return !!v;
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function load(table) {
    if (_cache[table]) return _cache[table];
    var headers = SCHEMA[table];
    var sh = sheet(table);
    var last = sh.getLastRow();
    var rows = [];
    if (last >= 2) {
      var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
      for (var i = 0; i < values.length; i++) {
        var r = values[i];
        if (r[0] === '' || r[0] === null) continue;
        var obj = { _row: i + 2 };
        for (var c = 0; c < headers.length; c++) obj[headers[c]] = fromCell(table, headers[c], r[c]);
        rows.push(obj);
      }
    }
    _cache[table] = rows;
    return rows;
  }

  function strip(o) {
    var copy = {};
    for (var k in o) if (k !== '_row') copy[k] = o[k];
    return copy;
  }

  function all(table) {
    return load(table).map(strip);
  }

  function where(table, fn) {
    return all(table).filter(fn);
  }

  function find(table, id) {
    id = Number(id);
    var rows = load(table);
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return strip(rows[i]);
    return null;
  }

  function findOrFail(table, id, label) {
    var r = find(table, id);
    if (!r) throw new Error((label || table) + ' not found.');
    return r;
  }

  function nowStr() {
    return Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm');
  }

  function insert(table, data) {
    var headers = SCHEMA[table];
    var rows = load(table);
    var record = {};
    for (var k in data) record[k] = data[k];
    if (headers.indexOf('id') !== -1) {
      var max = 0;
      rows.forEach(function (r) { if (r.id > max) max = r.id; });
      record.id = max + 1;
    }
    var now = nowStr();
    if (headers.indexOf('created_at') !== -1 && !record.created_at) record.created_at = now;
    if (headers.indexOf('updated_at') !== -1) record.updated_at = now;
    sheet(table).appendRow(headers.map(function (h) { return toCell(table, h, record[h]); }));
    delete _cache[table];
    return find(table, record.id) || record;
  }

  function update(table, id, patch) {
    id = Number(id);
    var headers = SCHEMA[table];
    var rows = load(table);
    var current = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) { current = rows[i]; break; }
    if (!current) throw new Error(table + ' #' + id + ' not found.');
    var merged = {};
    for (var k in current) merged[k] = current[k];
    for (var p in patch) if (p !== 'id' && p !== '_row' && p !== 'created_at') merged[p] = patch[p];
    if (headers.indexOf('updated_at') !== -1) merged.updated_at = nowStr();
    sheet(table).getRange(current._row, 1, 1, headers.length)
      .setValues([headers.map(function (h) { return toCell(table, h, merged[h]); })]);
    delete _cache[table];
    return strip(merged);
  }

  function remove(table, id) {
    id = Number(id);
    var rows = load(table);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === id) {
        sheet(table).deleteRow(rows[i]._row);
        delete _cache[table];
        return true;
      }
    }
    return false;
  }

  // ---- Settings (key/value table) ----
  function getSettings() {
    var out = {};
    for (var k in DEFAULT_SETTINGS) out[k] = DEFAULT_SETTINGS[k];
    var sh = sheet('Settings');
    var last = sh.getLastRow();
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
        if (r[0] !== '') out[String(r[0])] = r[1] instanceof Date ? fromCell('Settings', 'value', r[1]) : String(r[1]);
      });
    }
    // Old sample name from setup() -> Hotel GRS (a name set later in Settings still wins)
    if (out.hotel_name === 'Grand Horizon Hotel & Suites' || out.hotel_name === '' || /^\s*(grs\s*hot[ae]l|hot[ae]l\s*grs)\s*$/i.test(out.hotel_name)) out.hotel_name = 'Hotel GRS';
    return out;
  }

  function saveSettings(values) {
    var sh = sheet('Settings');
    var last = sh.getLastRow();
    var existing = {};
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r, i) { existing[String(r[0])] = i + 2; });
    }
    for (var k in values) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      var v = values[k] === null || values[k] === undefined ? '' : String(values[k]);
      if (existing[k]) sh.getRange(existing[k], 2).setValue(v);
      else { sh.appendRow([k, v]); existing[k] = sh.getLastRow(); }
    }
    return getSettings();
  }

  // ---- Assets (images as data URIs, split into 45k-char chunks; a cell holds max 50k chars) ----
  var CHUNK = 45000;
  function assetRows(key) {
    var sh = sheet('Assets');
    var last = sh.getLastRow();
    if (last < 2) return [];
    return sh.getRange(2, 1, last - 1, 3).getValues()
      .map(function (r, i) { return { row: i + 2, key: String(r[0]), chunk: Number(r[1]), data: String(r[2]) }; })
      .filter(function (r) { return r.key === key; });
  }

  function getAsset(key) {
    return assetRows(key)
      .sort(function (a, b) { return a.chunk - b.chunk; })
      .map(function (r) { return r.data.substring(1); }) // strip "~" guard
      .join('');
  }

  function deleteAsset(key) {
    var sh = sheet('Assets');
    assetRows(key).map(function (r) { return r.row; }).sort(function (a, b) { return b - a; })
      .forEach(function (row) { sh.deleteRow(row); });
  }

  function saveAsset(key, dataUri) {
    deleteAsset(key);
    var sh = sheet('Assets');
    for (var i = 0, n = 0; i < dataUri.length; i += CHUNK, n++) {
      // "~" guard stops Sheets from treating chunks that start with + / = as formulas or numbers
      sh.appendRow([key, n, '~' + dataUri.substring(i, i + CHUNK)]);
    }
  }

  return {
    getAsset: getAsset, saveAsset: saveAsset, deleteAsset: deleteAsset,
    ss: ss, sheet: sheet, tz: tz, nowStr: nowStr,
    all: all, where: where, find: find, findOrFail: findOrFail,
    insert: insert, update: update, remove: remove,
    getSettings: getSettings, saveSettings: saveSettings
  };
})();
