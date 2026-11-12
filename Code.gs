/**
 * Code.gs — web app entry point, API router, spreadsheet menu and one-time setup.
 */

var STAFF = ['admin', 'receptionist'];
var ADMIN = ['admin'];

// action -> { fn, roles, write, auth }
var ROUTES = {
  login:            { fn: function (p) { return Auth.login(p); }, auth: false, write: true },
  logout:           { fn: function (p, u, token) { return Auth.logout(token); }, roles: STAFF },
  bootstrap:        { fn: bootstrap_, roles: STAFF },
  changePassword:   { fn: function (p, u) { return Auth.changePassword(p, u); }, roles: STAFF, write: true },

  dashboard:        { fn: dashboard_, roles: STAFF },

  listRooms:        { fn: listRooms_, roles: STAFF },
  getRoom:          { fn: getRoom_, roles: STAFF },
  saveRoom:         { fn: saveRoom_, roles: STAFF, write: true },
  setRoomStatus:    { fn: setRoomStatus_, roles: STAFF, write: true },
  deleteRoom:       { fn: deleteRoom_, roles: STAFF, write: true },

  listGuests:       { fn: listGuests_, roles: STAFF },
  getGuest:         { fn: getGuest_, roles: STAFF },
  saveGuest:        { fn: saveGuest_, roles: STAFF, write: true },
  deleteGuest:      { fn: deleteGuest_, roles: STAFF, write: true },

  listBookings:     { fn: listBookings_, roles: STAFF },
  getBooking:       { fn: getBooking_, roles: STAFF },
  checkIn:          { fn: checkIn_, roles: STAFF, write: true },
  checkOut:         { fn: checkOut_, roles: STAFF, write: true },
  cancelBooking:    { fn: cancelBooking_, roles: STAFF, write: true },

  billingPrefill:   { fn: billingPrefill_, roles: STAFF },
  createInvoice:    { fn: createInvoice_, roles: STAFF, write: true },
  recordPayment:    { fn: recordPayment_, roles: STAFF, write: true },
  listInvoices:     { fn: listInvoices_, roles: STAFF },
  getInvoice:       { fn: getInvoice_, roles: STAFF },
  invoiceHtml:      { fn: invoiceHtml_, roles: STAFF },
  invoicePdf:       { fn: invoicePdf_, roles: STAFF },

  reports:          { fn: reports_, roles: ADMIN },
  getSettings:      { fn: function () { var s = Db.getSettings(); s.logo = Db.getAsset('logo'); s.signature = Db.getAsset('signature'); return s; }, roles: ADMIN },
  saveSettings:     { fn: saveSettings_, roles: ADMIN, write: true },
  saveAsset:        { fn: saveAsset_, roles: ADMIN, write: true },
  listUsers:        { fn: listUsers_, roles: ADMIN },
  saveUser:         { fn: saveUser_, roles: ADMIN, write: true },
  toggleUser:       { fn: toggleUser_, roles: ADMIN, write: true }
};

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('GRS Hotel')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * JSON API for the Flutter mobile app.
 * POST body: {"action": "...", "token": "...", "payload": {...}}  ->  same JSON as api().
 */
function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }
  var out = api(String(body.action || ''), body.token || null, body.payload || {});
  return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Single entry point called from the browser: google.script.run.api(action, token, payload).
 * Always returns a JSON string: { ok: true, data } or { ok: false, error, auth }.
 */
function api(action, token, payload) {
  var lock = null;
  try {
    var route = ROUTES[action];
    if (!route) throw new Error('Unknown action: ' + action);
    var user = route.auth === false ? null : Auth.requireUser(token, route.roles);
    if (route.write) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) throw new Error('System is busy, please try again.');
    }
    var data = route.fn(payload || {}, user, token);
    return JSON.stringify({ ok: true, data: data === undefined ? null : data });
  } catch (err) {
    var msg = String(err && err.message ? err.message : err);
    var isAuth = msg.indexOf('AUTH: ') === 0;
    if (!isAuth && !/required|invalid|not found|cannot|must|already|occupied|exists|permission|incorrect|attempts|busy|only|select|add at least/i.test(msg)) {
      console.error(action, err && err.stack ? err.stack : msg);
    }
    return JSON.stringify({ ok: false, error: msg.replace('AUTH: ', ''), auth: isAuth });
  } finally {
    if (lock) { SpreadsheetApp.flush(); lock.releaseLock(); }
  }
}

// ------------------------------------------------------------------ spreadsheet UI

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🏨 Hotel')
    .addItem('Setup / repair sheets', 'setup')
    .addItem('Add sample rooms', 'seedSampleRooms')
    .addSeparator()
    .addItem('How to open the app', 'showHelp')
    .addToUi();
}

function showHelp() {
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { /* not deployed yet */ }
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial;font-size:14px;line-height:1.6">' +
    (url ? '<p><b>Web app URL:</b><br><a href="' + url + '" target="_blank">' + url + '</a></p>'
         : '<p>The web app is not deployed yet.</p>') +
    '<ol><li>Extensions &gt; Apps Script</li><li>Deploy &gt; New deployment &gt; type <b>Web app</b></li>' +
    '<li>Execute as: <b>Me</b>, Who has access: <b>Anyone</b> (staff still need to log in)</li>' +
    '<li>Open the URL and sign in with <b>' + DEFAULT_ADMIN.email + '</b></li></ol></div>'
  ).setWidth(460).setHeight(260);
  SpreadsheetApp.getUi().showModalDialog(html, 'Hotel Management');
}

/**
 * Creates every sheet with headers + formatting, removes untouched default "SheetN" tabs,
 * writes default settings and the first admin. Safe to run again (never deletes data).
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var created = [];
  Object.keys(SCHEMA).forEach(function (name) {
    var headers = SCHEMA[name];
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); created.push(name); }

    if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
    var current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    var empty = current.every(function (v) { return v === ''; });
    if (empty || current.join('|') !== headers.join('|')) {
      if (!empty && sh.getLastRow() > 1) {
        throw new Error('Sheet "' + name + '" has data but different headers. Rename it and run setup again.');
      }
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    }

    // Text format for non-numeric columns (keeps phone numbers, dates, room "101A" etc. exactly as typed)
    headers.forEach(function (h, i) {
      var col = sh.getRange(1, i + 1, sh.getMaxRows(), 1);
      if ((NUMERIC[name] || []).indexOf(h) !== -1) {
        col.setNumberFormat(h === 'id' || /_id$|count|capacity|visits|_by$/.test(h) ? '0' : '#,##0.00');
      } else if ((BOOLEAN[name] || []).indexOf(h) === -1) {
        col.setNumberFormat('@');
      }
    });

    sh.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold').setFontColor('#ffffff').setBackground(HEADER_COLORS[name] || '#1e3a5f');
    sh.setFrozenRows(1);
    if (name === 'Assets') { sh.setColumnWidth(3, 300); sh.hideSheet(); }
    else sh.autoResizeColumns(1, headers.length);
  });

  // Hide the password columns from casual viewing
  var users = ss.getSheetByName('Users');
  users.hideColumns(SCHEMA.Users.indexOf('password_hash') + 1, 2);

  // Delete empty default tabs (Sheet1, Sheet2 ...)
  ss.getSheets().forEach(function (sh) {
    if (/^Sheet\d+$/i.test(sh.getName()) && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });

  // Default settings
  var current = Db.getSettings();
  Db.saveSettings(current);

  // First admin
  if (!Db.all('Users').length) {
    var salt = Utilities.getUuid();
    Db.insert('Users', {
      name: DEFAULT_ADMIN.name, email: DEFAULT_ADMIN.email, role: 'admin', phone: '',
      is_active: true, salt: salt, password_hash: hashPassword_(DEFAULT_ADMIN.password, salt)
    });
  }

  ss.setActiveSheet(ss.getSheetByName('Rooms'));
  var msg = 'Setup complete. ' + (created.length ? 'Created: ' + created.join(', ') + '. ' : '') +
    'Login: ' + DEFAULT_ADMIN.email + ' / ' + DEFAULT_ADMIN.password + ' (change it after first login).';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
  return msg;
}

/** Optional: adds a few demo rooms if the Rooms sheet is empty. */
function seedSampleRooms() {
  if (Db.all('Rooms').length) {
    try { SpreadsheetApp.getUi().alert('Rooms sheet already has data — nothing added.'); } catch (e) { }
    return;
  }
  [
    ['101', 'Standard', 2000, 300, '1', 2, 1, 'WiFi, TV, AC'],
    ['102', 'Standard', 2000, 300, '1', 2, 1, 'WiFi, TV, AC'],
    ['103', 'Deluxe', 3200, 450, '1', 2, 2, 'WiFi, TV, AC, Mini Bar'],
    ['201', 'Deluxe', 3200, 450, '2', 2, 2, 'WiFi, TV, AC, Mini Bar'],
    ['202', 'Suite', 5500, 800, '2', 3, 2, 'WiFi, TV, AC, Mini Bar, Bathtub'],
    ['301', 'Family', 4200, 600, '3', 4, 2, 'WiFi, TV, AC, Extra Bed']
  ].forEach(function (r) {
    Db.insert('Rooms', {
      room_number: r[0], room_type: r[1], price_per_night: r[2], price_per_hour: r[3], floor: r[4],
      capacity_adults: r[5], capacity_children: r[6], status: 'available', description: '', amenities: r[7]
    });
  });
  try { SpreadsheetApp.getUi().alert('Added 6 sample rooms.'); } catch (e) { }
}
