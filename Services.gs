/**
 * Services.gs — business logic (rooms, guests, bookings, billing, reports, users, settings).
 * Mirrors the Laravel BookingService / BillingService / controllers.
 */

// ----------------------------------------------------------------- helpers

function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function num_(v, def) { var n = Number(v); return v === '' || v === null || v === undefined || isNaN(n) ? (def || 0) : n; }
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function today_() { return Utilities.formatDate(new Date(), Db.tz(), 'yyyy-MM-dd'); }
function ymd_(d) { return Utilities.formatDate(d, Db.tz(), 'yyyyMMdd'); }

/** "2026-11-12T14:30" / "2026-11-12 14:30" -> Date (script timezone). */
function parseDt_(s) {
  s = str_(s).replace('T', ' ');
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) throw new Error('Invalid date/time: ' + s);
  var iso = m[1] + '-' + m[2] + '-' + m[3] + 'T' + ('0' + (m[4] || '0')).slice(-2) + ':' + (m[5] || '00') + ':00';
  return Utilities.parseDate(iso, Db.tz(), "yyyy-MM-dd'T'HH:mm:ss");
}
function fmtDt_(d) { return Utilities.formatDate(d, Db.tz(), 'yyyy-MM-dd HH:mm'); }
function normDt_(s) { return fmtDt_(parseDt_(s)); }
function dateOf_(s) { return str_(s).substring(0, 10); }
function inRange_(s, from, to) { var d = dateOf_(s); return d && (!from || d >= from) && (!to || d <= to); }

function required_(p, fields) {
  fields.forEach(function (f) {
    if (str_(p[f[0]]) === '') throw new Error(f[1] + ' is required.');
  });
}

function matches_(text, q) {
  return String(text || '').toLowerCase().indexOf(q) !== -1;
}

function nextNumber_(table, field, prefix) {
  var max = 0;
  Db.all(table).forEach(function (r) {
    var v = String(r[field] || '');
    if (v.indexOf(prefix) === 0) {
      var n = parseInt(v.substring(prefix.length), 10);
      if (n > max) max = n;
    }
  });
  return prefix + ('000' + (max + 1)).slice(-Math.max(3, String(max + 1).length));
}

function logActivity_(user, action, description, subjectType, subjectId) {
  try {
    Db.insert('ActivityLog', {
      user_id: user ? user.id : '', user_name: user ? user.name : 'System',
      action: action, description: description,
      subject_type: subjectType || '', subject_id: subjectId || ''
    });
  } catch (e) { /* never block a business action because of logging */ }
}

function indexBy_(rows) { var m = {}; rows.forEach(function (r) { m[r.id] = r; }); return m; }

// ----------------------------------------------------------------- rooms

function listRooms_(p) {
  var q = str_(p.search).toLowerCase();
  var active = {};
  var guests = indexBy_(Db.all('Guests'));
  Db.where('Bookings', function (b) { return b.status === 'checked_in'; }).forEach(function (b) {
    active[b.room_id] = { booking_id: b.id, booking_number: b.booking_number, guest_name: (guests[b.guest_id] || {}).full_name || '', expected_check_out_at: b.expected_check_out_at };
  });
  return Db.all('Rooms').filter(function (r) {
    if (p.status && r.status !== p.status) return false;
    if (p.room_type && r.room_type !== p.room_type) return false;
    if (q && !(matches_(r.room_number, q) || matches_(r.room_type, q) || matches_(r.floor, q))) return false;
    return true;
  }).map(function (r) { r.current = active[r.id] || null; return r; })
    .sort(function (a, b) { return String(a.room_number).localeCompare(String(b.room_number), undefined, { numeric: true }); });
}

function saveRoom_(p, user) {
  required_(p, [['room_number', 'Room number'], ['room_type', 'Room type'], ['price_per_night', 'Price per night']]);
  var number = str_(p.room_number);
  var id = num_(p.id);
  var dup = Db.where('Rooms', function (r) { return String(r.room_number).toLowerCase() === number.toLowerCase() && r.id !== id; });
  if (dup.length) throw new Error('Room number ' + number + ' already exists.');
  if (num_(p.price_per_night) < 0 || num_(p.price_per_hour) < 0) throw new Error('Prices cannot be negative.');
  var status = ROOM_STATUSES.indexOf(p.status) !== -1 ? p.status : 'available';

  var data = {
    room_number: number, room_type: str_(p.room_type),
    price_per_night: round2_(p.price_per_night), price_per_hour: round2_(p.price_per_hour),
    floor: str_(p.floor) || '1', capacity_adults: Math.max(1, num_(p.capacity_adults, 2)),
    capacity_children: num_(p.capacity_children, 0), status: status,
    description: str_(p.description), amenities: str_(p.amenities)
  };
  var room;
  if (id) { room = Db.update('Rooms', id, data); logActivity_(user, 'room_updated', 'Updated room ' + number + '.', 'Room', id); }
  else { room = Db.insert('Rooms', data); logActivity_(user, 'room_created', 'Added room ' + number + '.', 'Room', room.id); }
  return room;
}

function getRoom_(p) {
  var room = Db.findOrFail('Rooms', p.id, 'Room');
  var guests = indexBy_(Db.all('Guests'));
  room.bookings = Db.where('Bookings', function (b) { return b.room_id === room.id; })
    .sort(function (a, b) { return a.check_in_at < b.check_in_at ? 1 : -1; })
    .slice(0, 20)
    .map(function (b) { b.guest_name = (guests[b.guest_id] || {}).full_name || ''; return b; });
  return room;
}

function setRoomStatus_(p, user) {
  if (ROOM_STATUSES.indexOf(p.status) === -1) throw new Error('Invalid room status.');
  var room = Db.findOrFail('Rooms', p.id, 'Room');
  Db.update('Rooms', room.id, { status: p.status });
  logActivity_(user, 'room_status', 'Room ' + room.room_number + ' marked ' + p.status + '.', 'Room', room.id);
  return true;
}

function deleteRoom_(p, user) {
  var room = Db.findOrFail('Rooms', p.id, 'Room');
  if (Db.where('Bookings', function (b) { return b.room_id === room.id; }).length) {
    throw new Error('Room ' + room.room_number + ' has booking history and cannot be deleted. Mark it as maintenance instead.');
  }
  Db.remove('Rooms', room.id);
  logActivity_(user, 'room_deleted', 'Deleted room ' + room.room_number + '.', 'Room', room.id);
  return true;
}

// ----------------------------------------------------------------- guests

function maskId_(idNumber) {
  var s = str_(idNumber).replace(/\s+/g, '');
  if (!s) return '';
  return s.length <= 4 ? s : new Array(s.length - 3).join('X') + s.slice(-4);
}

function guestStats_(guestId) {
  var invoices = Db.where('Invoices', function (i) { return i.guest_id === guestId; });
  var paid = 0, billed = 0;
  invoices.forEach(function (i) { billed += i.grand_total; paid += i.paid_amount; });
  return { invoices_count: invoices.length, total_billed: round2_(billed), total_paid: round2_(paid) };
}

function listGuests_(p) {
  var q = str_(p.search).toLowerCase();
  return Db.all('Guests').filter(function (g) {
    return !q || matches_(g.full_name, q) || matches_(g.mobile_number, q) || matches_(g.email, q) || matches_(g.city, q);
  }).sort(function (a, b) { return b.id - a.id; });
}

function getGuest_(p) {
  var g = Db.findOrFail('Guests', p.id, 'Guest');
  var rooms = indexBy_(Db.all('Rooms'));
  g.bookings = Db.where('Bookings', function (b) { return b.guest_id === g.id; })
    .sort(function (a, b) { return b.id - a.id; })
    .map(function (b) { b.room_number = (rooms[b.room_id] || {}).room_number || ''; return b; });
  g.invoices = Db.where('Invoices', function (i) { return i.guest_id === g.id; }).sort(function (a, b) { return b.id - a.id; });
  var s = guestStats_(g.id);
  for (var k in s) g[k] = s[k];
  return g;
}

function saveGuest_(p, user) {
  required_(p, [['full_name', 'Full name'], ['mobile_number', 'Mobile number']]);
  var email = str_(p.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email address is not valid.');
  var data = {
    full_name: str_(p.full_name), mobile_number: str_(p.mobile_number), email: email,
    address: str_(p.address), city: str_(p.city), state: str_(p.state),
    country: str_(p.country) || 'India', postal_code: str_(p.postal_code),
    id_type: str_(p.id_type), notes: str_(p.notes)
  };
  if (str_(p.id_number)) data.id_number_masked = maskId_(p.id_number);
  var id = num_(p.id);
  var guest;
  if (id) { guest = Db.update('Guests', id, data); logActivity_(user, 'guest_updated', 'Updated guest ' + data.full_name + '.', 'Guest', id); }
  else {
    data.total_visits = 0;
    guest = Db.insert('Guests', data);
    logActivity_(user, 'guest_created', 'Registered guest ' + data.full_name + '.', 'Guest', guest.id);
  }
  return guest;
}

function deleteGuest_(p, user) {
  var g = Db.findOrFail('Guests', p.id, 'Guest');
  var hasHistory = Db.where('Bookings', function (b) { return b.guest_id === g.id; }).length ||
    Db.where('Invoices', function (i) { return i.guest_id === g.id; }).length;
  if (hasHistory) throw new Error(g.full_name + ' has bookings/invoices and cannot be deleted.');
  Db.remove('Guests', g.id);
  logActivity_(user, 'guest_deleted', 'Deleted guest ' + g.full_name + '.', 'Guest', g.id);
  return true;
}

// ----------------------------------------------------------------- bookings

function isRoomAvailable_(roomId, checkIn, checkOut, excludeBookingId) {
  var room = Db.find('Rooms', roomId);
  if (!room || room.status === 'maintenance') return false;
  var inMs = checkIn.getTime(), outMs = checkOut.getTime();
  return !Db.all('Bookings').some(function (b) {
    if (b.room_id !== room.id || b.status !== 'checked_in' || b.id === excludeBookingId) return false;
    return parseDt_(b.check_in_at).getTime() < outMs && parseDt_(b.expected_check_out_at).getTime() > inMs;
  });
}

function calculateStay_(room, billingType, checkIn, checkOut) {
  var units, rate;
  var ms = checkOut.getTime() - checkIn.getTime();
  if (billingType === 'hourly') {
    var minutes = Math.max(60, Math.floor(ms / 60000));
    units = round2_(minutes / 60);
    rate = room.price_per_hour > 0 ? room.price_per_hour : room.price_per_night / 24;
  } else {
    // Hotel nights = number of calendar dates crossed (12 Nov 2pm -> 14 Nov 11am = 2 nights), minimum 1
    var a = new Date(checkIn.getFullYear(), checkIn.getMonth(), checkIn.getDate());
    var b = new Date(checkOut.getFullYear(), checkOut.getMonth(), checkOut.getDate());
    units = Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000));
    rate = room.price_per_night;
  }
  return { billing_type: billingType, units: units, rate: round2_(rate), total_charge: round2_(units * rate) };
}

function enrichBookings_(list) {
  var guests = indexBy_(Db.all('Guests'));
  var rooms = indexBy_(Db.all('Rooms'));
  var invByBooking = {};
  Db.all('Invoices').forEach(function (i) { if (i.booking_id) invByBooking[i.booking_id] = i; });
  return list.map(function (b) {
    var g = guests[b.guest_id] || {}, r = rooms[b.room_id] || {}, inv = invByBooking[b.id];
    b.guest_name = g.full_name || ''; b.guest_mobile = g.mobile_number || '';
    b.room_number = r.room_number || ''; b.room_type = r.room_type || '';
    b.invoice_id = inv ? inv.id : ''; b.invoice_number = inv ? inv.invoice_number : '';
    b.payment_status = inv ? inv.payment_status : '';
    return b;
  });
}

function listBookings_(p) {
  var q = str_(p.search).toLowerCase();
  var list = enrichBookings_(Db.all('Bookings')).filter(function (b) {
    if (p.status && b.status !== p.status) return false;
    if (p.date && dateOf_(b.check_in_at) !== p.date) return false;
    if (q && !(matches_(b.booking_number, q) || matches_(b.guest_name, q) || matches_(b.guest_mobile, q) || matches_(b.room_number, q))) return false;
    return true;
  });
  return list.sort(function (a, b) { return b.id - a.id; });
}

function getBooking_(p) {
  var b = enrichBookings_([Db.findOrFail('Bookings', p.id, 'Booking')])[0];
  b.guest = Db.find('Guests', b.guest_id);
  b.room = Db.find('Rooms', b.room_id);
  return b;
}

function checkIn_(p, user) {
  var guestId = num_(p.guest_id);
  if (!guestId) {
    // Quick check-in: register a new guest on the fly
    if (!p.new_guest) throw new Error('Select a guest or enter new guest details.');
    guestId = saveGuest_(p.new_guest, user).id;
  }
  var guest = Db.findOrFail('Guests', guestId, 'Guest');
  required_(p, [['room_id', 'Room'], ['check_in_at', 'Check-in date & time'], ['expected_check_out_at', 'Expected check-out date & time']]);

  var checkIn = parseDt_(p.check_in_at);
  var checkOut = parseDt_(p.expected_check_out_at);
  if (checkOut.getTime() <= checkIn.getTime()) throw new Error('Expected check-out date & time must be after check-in date & time.');

  var room = Db.findOrFail('Rooms', p.room_id, 'Room');
  var adults = num_(p.adults_count, 1), children = num_(p.children_count, 0);
  if (adults < 1 || adults > 10 || children < 0 || children > 10) throw new Error('Adults must be 1-10 and children 0-10.');

  var isManual = p.is_manual === true || p.is_manual === 'true' || p.is_manual === 'on';
  if (!isManual && !isRoomAvailable_(room.id, checkIn, checkOut)) {
    throw new Error('Room ' + room.room_number + ' is currently occupied or under maintenance during this time slot.');
  }

  var billingType = p.billing_type === 'hourly' ? 'hourly' : 'nightly';
  var calc;
  if (isManual) {
    var auto = calculateStay_(room, billingType, checkIn, checkOut);
    var units = num_(p.custom_duration) > 0 ? num_(p.custom_duration) : auto.units;
    var rate = num_(p.custom_rate) > 0 ? num_(p.custom_rate) : auto.rate;
    var total = num_(p.custom_total) > 0 ? num_(p.custom_total) : round2_(units * rate);
    calc = { billing_type: billingType, units: units, rate: round2_(rate), total_charge: round2_(total) };
  } else {
    calc = calculateStay_(room, billingType, checkIn, checkOut);
  }

  var booking = Db.insert('Bookings', {
    booking_number: nextNumber_('Bookings', 'booking_number', 'BKG-' + ymd_(new Date()) + '-'),
    guest_id: guest.id, room_id: room.id,
    check_in_at: fmtDt_(checkIn), expected_check_out_at: fmtDt_(checkOut), actual_check_out_at: '',
    stay_type: p.stay_type || (billingType === 'hourly' ? 'hourly' : 'overnight'),
    billing_type: calc.billing_type, rate_applied: calc.rate, units_booked: calc.units,
    total_charge: calc.total_charge, adults_count: adults, children_count: children,
    status: 'checked_in', special_notes: str_(p.special_notes), created_by: user.id
  });

  Db.update('Rooms', room.id, { status: 'occupied' });
  Db.update('Guests', guest.id, { total_visits: (guest.total_visits || 0) + 1 });
  logActivity_(user, 'check_in', 'Checked in ' + guest.full_name + ' into Room ' + room.room_number + ' (' + booking.booking_number + ').', 'Booking', booking.id);
  return booking;
}

function checkOut_(p, user) {
  var b = Db.findOrFail('Bookings', p.id, 'Booking');
  if (b.status !== 'checked_in') throw new Error('Only checked-in bookings can be checked out.');
  var when = p.actual_check_out_at ? normDt_(p.actual_check_out_at) : Db.nowStr();
  Db.update('Bookings', b.id, { actual_check_out_at: when, status: 'checked_out' });
  var room = Db.find('Rooms', b.room_id);
  if (room) Db.update('Rooms', room.id, { status: p.room_status === 'cleaning' ? 'cleaning' : 'available' });
  var g = Db.find('Guests', b.guest_id) || {};
  logActivity_(user, 'check_out', 'Checked out ' + (g.full_name || '') + ' from Room ' + (room ? room.room_number : '') + ' (' + b.booking_number + ').', 'Booking', b.id);
  return true;
}

function cancelBooking_(p, user) {
  var b = Db.findOrFail('Bookings', p.id, 'Booking');
  if (b.status !== 'checked_in') throw new Error('Only active bookings can be cancelled.');
  Db.update('Bookings', b.id, { status: 'cancelled' });
  var room = Db.find('Rooms', b.room_id);
  if (room && room.status === 'occupied') Db.update('Rooms', room.id, { status: 'available' });
  logActivity_(user, 'booking_cancelled', 'Cancelled booking ' + b.booking_number + '.', 'Booking', b.id);
  return true;
}

function deleteBookings_(p, user) {
  var rawIds = Array.isArray(p.ids) ? p.ids : (p.id ? [p.id] : []);
  var ids = rawIds.map(function (v) { return num_(v); }).filter(function (v) { return v > 0; });
  if (!ids.length) throw new Error('Select at least one booking to delete.');

  var deleted = 0;
  var roomIdsToCheck = {};
  ids.forEach(function (id) {
    var b = Db.find('Bookings', id);
    if (!b) return;
    if (b.status === 'checked_in' && b.room_id) roomIdsToCheck[b.room_id] = true;
    Db.where('Invoices', function (i) { return i.booking_id === b.id; }).forEach(function (i) {
      Db.update('Invoices', i.id, { booking_id: '' });
    });
    Db.where('Payments', function (pm) { return pm.booking_id === b.id; }).forEach(function (pm) {
      Db.update('Payments', pm.id, { booking_id: '' });
    });
    if (Db.remove('Bookings', b.id)) deleted++;
  });

  Object.keys(roomIdsToCheck).forEach(function (rid) {
    var roomId = num_(rid);
    var stillOccupied = Db.where('Bookings', function (b) {
      return b.room_id === roomId && b.status === 'checked_in';
    }).length > 0;
    if (!stillOccupied) {
      var room = Db.find('Rooms', roomId);
      if (room && room.status === 'occupied') Db.update('Rooms', roomId, { status: 'available' });
    }
  });

  if (deleted > 0) {
    logActivity_(user, 'bookings_deleted', 'Deleted ' + deleted + ' booking(s).');
  }
  return { deleted: deleted };
}

// ----------------------------------------------------------------- billing / invoices

function recalcInvoice_(invoiceId) {
  var inv = Db.findOrFail('Invoices', invoiceId, 'Invoice');
  var t = { room: 0, food: 0, service: 0, other: 0, discount: 0 };
  Db.where('InvoiceItems', function (i) { return i.invoice_id === inv.id; }).forEach(function (i) {
    if (i.category === 'discount') t.discount += Math.abs(i.total_price);
    else if (t.hasOwnProperty(i.category)) t[i.category] += i.total_price;
    else t.other += i.total_price;
  });
  var subtotal = Math.max(0, t.room + t.food + t.service + t.other - t.discount);
  var tax = round2_(subtotal * inv.tax_rate / 100);
  var grand = round2_(subtotal + tax);
  var paid = 0;
  Db.where('Payments', function (pm) { return pm.invoice_id === inv.id; }).forEach(function (pm) { paid += pm.amount; });
  paid = round2_(paid);
  var status = 'unpaid';
  if (paid >= grand && grand > 0) status = 'paid'; else if (paid > 0) status = 'partially_paid';
  return Db.update('Invoices', inv.id, {
    room_charges: round2_(t.room), food_charges: round2_(t.food), service_charges: round2_(t.service),
    other_charges: round2_(t.other), discount_amount: round2_(t.discount), subtotal: round2_(subtotal),
    tax_amount: tax, grand_total: grand, paid_amount: paid,
    balance_amount: Math.max(0, round2_(grand - paid)), payment_status: status
  });
}

function billingPrefill_(p) {
  var settings = Db.getSettings();
  var out = { settings: settings, booking: null, guest: null, items: [] };
  if (p.booking_id) {
    var b = getBooking_({ id: p.booking_id });
    if (b.invoice_id) throw new Error('Booking ' + b.booking_number + ' already has invoice ' + b.invoice_number + '.');
    out.booking = b;
    out.guest = b.guest;
    var unitLabel = b.billing_type === 'hourly' ? 'Hours' : 'Nights';
    out.items.push({
      description: 'Room Accommodation - Room ' + b.room_number + ' (' + b.units_booked + ' ' + unitLabel + ')',
      category: 'room', quantity: b.units_booked, unit_price: b.rate_applied
    });
  }
  out.open_bookings = enrichBookings_(Db.where('Bookings', function (b) { return b.status !== 'cancelled'; }))
    .filter(function (b) { return !b.invoice_id; })
    .sort(function (a, b) { return b.id - a.id; })
    .map(function (b) { return { id: b.id, label: b.booking_number + ' — ' + b.guest_name + ' (Room ' + b.room_number + ')' }; });
  return out;
}

function createInvoice_(p, user) {
  var settings = Db.getSettings();
  var booking = p.booking_id ? Db.findOrFail('Bookings', p.booking_id, 'Booking') : null;
  var guestId = booking ? booking.guest_id : num_(p.guest_id);
  if (!guestId) throw new Error('Select a booking or a guest for this invoice.');
  var guest = Db.findOrFail('Guests', guestId, 'Guest');
  if (booking && Db.where('Invoices', function (i) { return i.booking_id === booking.id; }).length) {
    throw new Error('This booking already has an invoice.');
  }

  var items = (p.items || []).filter(function (i) { return str_(i.description) && str_(i.unit_price) !== ''; });
  if (!items.length) throw new Error('Add at least one invoice item.');
  items.forEach(function (i) {
    if (num_(i.quantity, 1) < 0.01) throw new Error('Item quantity must be at least 0.01.');
    if (ITEM_CATEGORIES.indexOf(i.category) === -1) i.category = 'other';
  });
  var taxRate = str_(p.tax_rate) !== '' ? num_(p.tax_rate) : num_(settings.tax_rate);
  if (taxRate < 0 || taxRate > 100) throw new Error('Tax rate must be between 0 and 100.');

  // Sequential invoice number from settings
  var prefix = settings.invoice_prefix || 'INV-';
  var n = Math.max(1, parseInt(settings.next_invoice_number, 10) || 1001);
  var existing = {};
  Db.all('Invoices').forEach(function (i) { existing[i.invoice_number] = true; });
  while (existing[prefix + n]) n++;
  Db.saveSettings({ next_invoice_number: String(n + 1) });

  var snapshot = {};
  ['hotel_name', 'address', 'city', 'state', 'country', 'postal_code', 'phone', 'email', 'website', 'gstin',
    'terms_and_conditions', 'footer_message', 'bank_name', 'bank_account_number', 'bank_ifsc', 'bank_upi_id',
    'currency_symbol'].forEach(function (k) { snapshot[k] = settings[k]; });

  var method = PAYMENT_METHODS.indexOf(p.primary_payment_method) !== -1 ? p.primary_payment_method : 'cash';
  var inv = Db.insert('Invoices', {
    invoice_number: prefix + n, booking_id: booking ? booking.id : '', guest_id: guest.id,
    invoice_date: str_(p.invoice_date) || today_(), due_date: str_(p.due_date) || today_(),
    tax_name: str_(p.tax_name) || settings.tax_name, tax_rate: taxRate,
    payment_status: 'unpaid', primary_payment_method: method,
    hotel_snapshot: snapshot, notes: str_(p.notes), created_by: user.id
  });

  items.forEach(function (i) {
    var qty = Math.max(0.01, num_(i.quantity, 1));
    var price = num_(i.unit_price);
    Db.insert('InvoiceItems', {
      invoice_id: inv.id, description: str_(i.description), category: i.category,
      quantity: qty, unit_price: price, total_price: round2_(qty * price)
    });
  });
  inv = recalcInvoice_(inv.id);

  if (num_(p.initial_payment_amount) > 0) {
    recordPayment_({
      invoice_id: inv.id, amount: p.initial_payment_amount, payment_method: method,
      transaction_reference: p.payment_reference, note: p.payment_note || 'Initial payment on invoice creation.'
    }, user);
  }
  logActivity_(user, 'invoice_created', 'Created invoice ' + inv.invoice_number + ' for ' + guest.full_name + ' (total ' + inv.grand_total.toFixed(2) + ').', 'Invoice', inv.id);

  if (booking && p.checkout_after && booking.status === 'checked_in') {
    checkOut_({ id: booking.id }, user);
  }
  return Db.find('Invoices', inv.id);
}

function recordPayment_(p, user) {
  var inv = Db.findOrFail('Invoices', p.invoice_id, 'Invoice');
  var amount = round2_(p.amount);
  if (amount < 0.01) throw new Error('Payment amount must be at least 0.01.');
  var method = PAYMENT_METHODS.indexOf(p.payment_method) !== -1 ? p.payment_method : 'cash';
  var pay = Db.insert('Payments', {
    payment_number: nextNumber_('Payments', 'payment_number', 'PAY-' + ymd_(new Date()) + '-'),
    invoice_id: inv.id, booking_id: inv.booking_id, guest_id: inv.guest_id, amount: amount,
    payment_date: p.payment_date ? normDt_(p.payment_date) : Db.nowStr(),
    payment_method: method, transaction_reference: str_(p.transaction_reference),
    note: str_(p.note), recorded_by: user.id
  });
  recalcInvoice_(inv.id);
  logActivity_(user, 'payment_recorded', 'Recorded payment ' + amount.toFixed(2) + ' (' + method + ') for invoice ' + inv.invoice_number + '.', 'Payment', pay.id);
  return pay;
}

function listInvoices_(p) {
  var q = str_(p.search).toLowerCase();
  var guests = indexBy_(Db.all('Guests'));
  return Db.all('Invoices').map(function (i) {
    i.guest_name = (guests[i.guest_id] || {}).full_name || '';
    delete i.hotel_snapshot;
    return i;
  }).filter(function (i) {
    if (p.payment_status && i.payment_status !== p.payment_status) return false;
    if ((p.date_from || p.date_to) && !inRange_(i.invoice_date, p.date_from, p.date_to)) return false;
    if (q && !(matches_(i.invoice_number, q) || matches_(i.guest_name, q))) return false;
    return true;
  }).sort(function (a, b) { return b.id - a.id; });
}

function getInvoice_(p) {
  var inv = Db.findOrFail('Invoices', p.id, 'Invoice');
  try { inv.hotel = JSON.parse(inv.hotel_snapshot || '{}'); } catch (e) { inv.hotel = {}; }
  delete inv.hotel_snapshot;
  if (inv.hotel) {
    if (inv.hotel.bank_account_number === '9090909090' || inv.hotel.bank_ifsc === 'HDFC0000123') {
      delete inv.hotel.bank_name;
      delete inv.hotel.bank_account_number;
      delete inv.hotel.bank_ifsc;
      delete inv.hotel.bank_upi_id;
    }
    if (!inv.hotel.hotel_name || /^\s*(grs\s*hot[ae]l|hot[ae]l\s*grs|grand horizon hotel & suites)\s*$/i.test(inv.hotel.hotel_name)) {
      inv.hotel.hotel_name = 'Hotel GRS';
    }
  }
  inv.guest = Db.find('Guests', inv.guest_id) || {};
  inv.booking = inv.booking_id ? enrichBookings_([Db.find('Bookings', inv.booking_id)].filter(Boolean))[0] || null : null;
  inv.items = Db.where('InvoiceItems', function (i) { return i.invoice_id === inv.id; });
  var users = indexBy_(Db.all('Users'));
  inv.payments = Db.where('Payments', function (pm) { return pm.invoice_id === inv.id; }).map(function (pm) {
    pm.recorded_by_name = (users[pm.recorded_by] || {}).name || '';
    return pm;
  });
  return inv;
}

/** 1234567.5 -> "12,34,567.50" (Indian digit grouping). */
function formatIndian_(amount) {
  amount = Number(amount) || 0;
  var parts = Math.abs(amount).toFixed(2).split('.');
  var whole = parts[0];
  if (whole.length > 3) {
    whole = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3);
  }
  return (amount < 0 ? '-' : '') + whole + '.' + parts[1];
}

/** 5376 -> "Five Thousand Three Hundred Seventy Six" (crore / lakh system). */
function spellIndian_(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  var ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  var tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  var below100 = function (x) { return x < 20 ? ones[x] : (tens[Math.floor(x / 10)] + ' ' + ones[x % 10]).trim(); };
  var below1000 = function (x) {
    var out = [];
    if (Math.floor(x / 100)) out.push(ones[Math.floor(x / 100)] + ' Hundred');
    if (x % 100) out.push(below100(x % 100));
    return out.join(' ');
  };
  if (n === 0) return 'Zero';
  var parts = [];
  var crore = Math.floor(n / 10000000); n %= 10000000;
  var lakh = Math.floor(n / 100000); n %= 100000;
  var thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(spellIndian_(crore) + ' Crore');
  if (lakh) parts.push(below100(lakh) + ' Lakh');
  if (thousand) parts.push(below100(thousand) + ' Thousand');
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}

function amountInWords_(amount) {
  var grand = round2_(amount);
  var rupees = Math.floor(grand);
  var paise = Math.round((grand - rupees) * 100);
  return (spellIndian_(rupees) + ' Rupees' + (paise > 0 ? ' and ' + spellIndian_(paise) + ' Paise' : '') + ' Only').toUpperCase();
}

/** "2026-11-12 14:30" -> "12-Nov-2026 02:30 PM" ; withTime=false -> "12-Nov-2026" */
function fmtBill_(s, withTime) {
  if (!str_(s)) return '';
  var d = parseDt_(s);
  return Utilities.formatDate(d, Db.tz(), withTime ? 'dd-MMM-yyyy hh:mm a' : 'dd-MMM-yyyy');
}

/** Printable tax invoice HTML (used for Print and PDF) — same layout as the Laravel invoice. */
function invoiceHtml_(p) {
  var inv = getInvoice_(p);
  var s = Db.getSettings();
  var snap = inv.hotel || {};
  // Current hotel settings win; the snapshot taken when the invoice was created is the fallback.
  var pick = function (k) { return str_(s[k]) || str_(snap[k]); };
  var h = {};
  ['hotel_name', 'address', 'city', 'state', 'country', 'postal_code', 'phone', 'email', 'gstin', 'terms_and_conditions'].forEach(function (k) { h[k] = pick(k); });
  var bankKeys = ['bank_name', 'bank_account_number', 'bank_ifsc', 'bank_upi_id'];
  if (!h.hotel_name || /^\s*(grs\s*hot[ae]l|hot[ae]l\s*grs|grand horizon hotel & suites)\s*$/i.test(h.hotel_name)) h.hotel_name = 'Hotel GRS';
  var hasBank = bankKeys.some(function (k) { return str_(s[k]).length > 0; });
  bankKeys.forEach(function (k) { h[k] = hasBank ? str_(s[k]) : ''; });
  h.full_address = [h.address, h.city, (h.state + (h.postal_code ? ' - ' + h.postal_code : '')).trim(), h.country]
    .filter(function (x) { return x; }).join(', ');

  var lines = inv.items.filter(function (i) { return i.category !== 'discount'; });
  var gross = round2_(lines.reduce(function (sum, i) { return sum + i.total_price; }, 0));
  var cgst = round2_(inv.tax_amount / 2);
  var num = function (v) { return String(round2_(v)); }; // 6.00 -> "6", 1.5 -> "1.5"

  var t = HtmlService.createTemplateFromFile('InvoicePrint');
  t.inv = inv;
  t.h = h;
  t.hasBank = hasBank;
  t.g = inv.guest || {};
  // "XXXXXXXX8841" -> "•••• •••• 8841"
  t.idMasked = String(t.g.id_number_masked || '').replace(/^(X+)(.{1,4})$/, function (m, xs, last) {
    return xs.replace(/X{1,4}/g, function (grp) { return new Array(grp.length + 1).join('•') + ' '; }) + last;
  });
  t.b = inv.booking;
  t.lines = lines;
  t.gross = gross;
  t.isGst = String(inv.tax_name).toUpperCase() === 'GST';
  t.halfRate = num(inv.tax_rate / 2);
  t.taxRate = num(inv.tax_rate);
  t.cgst = cgst;
  t.sgst = round2_(inv.tax_amount - cgst);
  t.words = amountInWords_(inv.grand_total);
  t.creator = (Db.find('Users', inv.created_by) || {}).name || '';
  t.logo = Db.getAsset('logo');
  t.signature = Db.getAsset('signature');
  // Stretch the items area so the invoice fills one A4 page; shrink it as rows / text grow.
  var termsLines = h.terms_and_conditions ? h.terms_and_conditions.split(/\r?\n/).length : 1;
  var longRows = lines.filter(function (i) { return String(i.description).length > 55; }).length;
  t.fillerHeight = Math.max(20, 270 - lines.length * 30 - longRows * 16 - Math.max(0, termsLines - 4) * 15);
  t.amt = formatIndian_;
  t.num = num;
  t.fmt = fmtBill_;
  t.sac = { room: '996311', food: '996331' };
  t.modes = { cash: 'Cash', credit_card: 'Credit Card', debit_card: 'Debit Card', bank_transfer: 'Bank Transfer', upi: 'UPI', cheque: 'Cheque' };
  return t.evaluate().getContent();
}

/** Upload / remove the hotel logo or signature-stamp image (admin). */
function saveAsset_(p, user) {
  if (ASSET_KEYS.indexOf(p.key) === -1) throw new Error('Invalid image type.');
  var data = str_(p.data);
  if (!data) {
    Db.deleteAsset(p.key);
    logActivity_(user, 'settings_updated', 'Removed hotel ' + p.key + '.');
    return true;
  }
  if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/=]+$/.test(data)) throw new Error('Please upload a PNG, JPG, GIF or WEBP image.');
  if (data.length > 700000) throw new Error('Image is too large. Please use a smaller image (under ~500 KB).');
  Db.saveAsset(p.key, data);
  logActivity_(user, 'settings_updated', 'Updated hotel ' + p.key + '.');
  return true;
}

function invoicePdf_(p) {
  var inv = Db.findOrFail('Invoices', p.id, 'Invoice');
  var blob = Utilities.newBlob(invoiceHtml_(p), 'text/html', 'invoice.html').getAs('application/pdf');
  var num = String(inv.invoice_number || '').trim();
  var fname = /^HOTEL-GRS-/i.test(num) ? num : ('HOTEL-GRS-' + num);
  if (!/\.pdf$/i.test(fname)) fname += '.pdf';
  return { filename: fname, base64: Utilities.base64Encode(blob.getBytes()) };
}

// ----------------------------------------------------------------- dashboard & reports

function dashboard_() {
  var today = today_();
  var rooms = Db.all('Rooms');
  var bookings = enrichBookings_(Db.all('Bookings'));
  var payments = Db.all('Payments');
  var invoices = Db.all('Invoices');
  var count = function (st) { return rooms.filter(function (r) { return r.status === st; }).length; };
  var sum = function (arr) { return round2_(arr.reduce(function (s, x) { return s + x.amount; }, 0)); };
  var occupied = count('occupied');
  var guests = Db.all('Guests');
  var guestIdx = indexBy_(guests);

  return {
    stats: {
      total_guests: guests.length,
      today_check_ins: bookings.filter(function (b) { return dateOf_(b.check_in_at) === today && b.status !== 'cancelled'; }).length,
      today_check_outs: bookings.filter(function (b) { return dateOf_(b.actual_check_out_at) === today || (b.status === 'checked_in' && dateOf_(b.expected_check_out_at) === today); }).length,
      in_house: bookings.filter(function (b) { return b.status === 'checked_in'; }).length,
      total_invoices: invoices.length,
      total_revenue: sum(payments),
      today_revenue: sum(payments.filter(function (pm) { return dateOf_(pm.payment_date) === today; })),
      outstanding: round2_(invoices.reduce(function (s, i) { return s + i.balance_amount; }, 0)),
      total_rooms: rooms.length,
      occupied_rooms: occupied,
      available_rooms: count('available'),
      maintenance_rooms: count('maintenance'),
      cleaning_rooms: count('cleaning'),
      occupancy_rate: rooms.length ? Math.round(occupied / rooms.length * 1000) / 10 : 0
    },
    due_checkouts: bookings.filter(function (b) { return b.status === 'checked_in' && dateOf_(b.expected_check_out_at) <= today; }).slice(0, 8),
    recent_bookings: bookings.sort(function (a, b) { return b.id - a.id; }).slice(0, 6),
    recent_invoices: invoices.sort(function (a, b) { return b.id - a.id; }).slice(0, 5).map(function (i) {
      return { id: i.id, invoice_number: i.invoice_number, guest_name: (guestIdx[i.guest_id] || {}).full_name || '', grand_total: i.grand_total, payment_status: i.payment_status, invoice_date: i.invoice_date };
    }),
    recent_activity: Db.all('ActivityLog').sort(function (a, b) { return b.id - a.id; }).slice(0, 10),
    settings: Db.getSettings()
  };
}

function reports_(p) {
  var from = str_(p.date_from) || today_().substring(0, 8) + '01';
  var to = str_(p.date_to) || today_();
  var q = str_(p.search).toLowerCase();
  var bookings = enrichBookings_(Db.all('Bookings'));
  var guests = Db.all('Guests');
  var gIdx = indexBy_(guests);
  var bySearch = function (b) { return !q || matches_(b.guest_name, q) || matches_(b.guest_mobile, q) || matches_(b.booking_number, q); };

  var checkins = bookings.filter(function (b) { return inRange_(b.check_in_at, from, to) && bySearch(b); })
    .sort(function (a, b) { return a.check_in_at < b.check_in_at ? 1 : -1; });
  var checkouts = bookings.filter(function (b) {
    return (b.actual_check_out_at ? inRange_(b.actual_check_out_at, from, to) : (b.status === 'checked_in' && inRange_(b.expected_check_out_at, from, to))) && bySearch(b);
  }).sort(function (a, b) { return (a.actual_check_out_at || a.expected_check_out_at) < (b.actual_check_out_at || b.expected_check_out_at) ? 1 : -1; });

  var invNum = {};
  var invoices = Db.all('Invoices').map(function (i) {
    invNum[i.id] = i.invoice_number;
    delete i.hotel_snapshot;
    i.guest_name = (gIdx[i.guest_id] || {}).full_name || '';
    return i;
  });
  var payments = Db.all('Payments').map(function (pm) {
    pm.guest_name = (gIdx[pm.guest_id] || {}).full_name || '';
    pm.invoice_number = invNum[pm.invoice_id] || '';
    return pm;
  }).filter(function (pm) {
    return inRange_(pm.payment_date, from, to) && (!q || matches_(pm.payment_number, q) || matches_(pm.transaction_reference, q) || matches_(pm.guest_name, q) || matches_(pm.invoice_number, q));
  }).sort(function (a, b) { return a.payment_date < b.payment_date ? 1 : -1; });

  var billing = invoices.filter(function (i) {
    return inRange_(i.invoice_date, from, to) && (!q || matches_(i.invoice_number, q) || matches_(i.guest_name, q));
  }).sort(function (a, b) { return a.invoice_date < b.invoice_date ? 1 : -1; });

  var byMethod = {};
  payments.forEach(function (pm) { byMethod[pm.payment_method] = round2_((byMethod[pm.payment_method] || 0) + pm.amount); });

  var guestHistory = guests.filter(function (g) {
    return !q || matches_(g.full_name, q) || matches_(g.mobile_number, q) || matches_(g.email, q);
  }).map(function (g) {
    var s = guestStats_(g.id);
    return {
      id: g.id, full_name: g.full_name, mobile_number: g.mobile_number, city: g.city, total_visits: g.total_visits,
      bookings_count: bookings.filter(function (b) { return b.guest_id === g.id; }).length,
      invoices_count: s.invoices_count, total_billed: s.total_billed, total_paid: s.total_paid
    };
  }).sort(function (a, b) { return b.total_visits - a.total_visits; });

  var tot = function (arr, f) { return round2_(arr.reduce(function (s, x) { return s + x[f]; }, 0)); };
  return {
    date_from: from, date_to: to,
    checkins: checkins, checkouts: checkouts, payments: payments, billing: billing, guests: guestHistory,
    totals: {
      payments: tot(payments, 'amount'), by_method: byMethod,
      billed: tot(billing, 'grand_total'), tax: tot(billing, 'tax_amount'),
      paid: tot(billing, 'paid_amount'), balance: tot(billing, 'balance_amount')
    }
  };
}

// ----------------------------------------------------------------- users & settings (admin)

function listUsers_(p, user) {
  ensureCoreUsers_();
  var isDevOrAdmin = user && (user.role === 'developer' || user.role === 'admin');
  return Db.all('Users').map(function (u) { return publicUser_(u, isDevOrAdmin); });
}

function saveUser_(p, user) {
  required_(p, [['name', 'Name'], ['email', 'Email']]);
  var email = str_(p.email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email address is not valid.');
  var id = num_(p.id);
  if (Db.where('Users', function (u) { return String(u.email).toLowerCase() === email && u.id !== id; }).length) {
    throw new Error('A user with this email already exists.');
  }
  var role = p.role === 'reception' ? 'receptionist' : (USER_ROLES.indexOf(p.role) !== -1 ? p.role : 'receptionist');
  if (id === user.id && role !== user.role && user.role === 'admin' && role !== 'admin') throw new Error('You cannot remove your own admin role.');
  var data = { name: str_(p.name), email: email, role: role, phone: str_(p.phone) };
  if (str_(p.password)) {
    if (String(p.password).length < 6) throw new Error('Password must be at least 6 characters.');
    data.salt = Utilities.getUuid();
    data.password_hash = hashPassword_(String(p.password), data.salt);
    data.password_display = String(p.password);
  } else if (!id) {
    throw new Error('Password is required for new users.');
  }
  var saved;
  if (id) { saved = Db.update('Users', id, data); logActivity_(user, 'user_updated', 'Updated staff ' + data.name + '.', 'User', id); }
  else { data.is_active = true; saved = Db.insert('Users', data); logActivity_(user, 'user_created', 'Added staff ' + data.name + ' (' + role + ').', 'User', saved.id); }
  return publicUser_(saved, true);
}

function toggleUser_(p, user) {
  var u = Db.findOrFail('Users', p.id, 'User');
  if (u.id === user.id) throw new Error('You cannot deactivate your own account.');
  Db.update('Users', u.id, { is_active: !u.is_active });
  logActivity_(user, 'user_status', (u.is_active ? 'Deactivated ' : 'Activated ') + u.name + '.', 'User', u.id);
  return true;
}

function deleteUser_(p, user) {
  var id = num_(p.id);
  var u = Db.findOrFail('Users', id, 'User');
  if (u.id === user.id) throw new Error('You cannot delete your own account.');
  if (u.email === 'developer2004@gmail.com' && user.email !== 'developer2004@gmail.com') {
    throw new Error('Developer account cannot be deleted.');
  }
  Db.remove('Users', id);
  logActivity_(user, 'user_deleted', 'Deleted user ' + u.name + ' (' + u.email + ').', 'User', id);
  return true;
}

function saveSettings_(p, user) {
  required_(p, [['hotel_name', 'Hotel name']]);
  if (num_(p.tax_rate) < 0 || num_(p.tax_rate) > 100) throw new Error('Tax rate must be between 0 and 100.');
  if (num_(p.next_invoice_number) < 1) throw new Error('Next invoice number must be at least 1.');
  var s = Db.saveSettings(p);
  logActivity_(user, 'settings_updated', 'Updated hotel settings.');
  return s;
}

function bootstrap_(p, user) {
  return {
    user: publicUser_(user),
    settings: Db.getSettings(),
    logo: Db.getAsset('logo'),
    lists: { room_statuses: ROOM_STATUSES, payment_methods: PAYMENT_METHODS, item_categories: ITEM_CATEGORIES, id_types: ID_TYPES, roles: USER_ROLES },
    room_types: Db.all('Rooms').map(function (r) { return r.room_type; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; }),
    dashboard: (p && p.includeDashboard) ? dashboard_() : null
  };
}
