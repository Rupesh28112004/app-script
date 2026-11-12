/**
 * Hotel Management & Billing System — Google Apps Script edition
 * Port of the Laravel "hotel-management" project.
 *
 * Config.gs — sheet schema, defaults and constants.
 */

// First admin account created by setup(). CHANGE THE PASSWORD after first login.
var DEFAULT_ADMIN = {
  name: 'Administrator',
  email: 'admin@hotel.com',
  password: 'admin123'
};

var ROOM_STATUSES = ['available', 'occupied', 'maintenance', 'cleaning'];
var PAYMENT_METHODS = ['cash', 'upi', 'credit_card', 'debit_card', 'bank_transfer', 'cheque'];
var ITEM_CATEGORIES = ['room', 'food', 'service', 'other', 'discount'];
var ID_TYPES = ['Aadhaar', 'Passport', 'Driving License', 'Voter ID', 'PAN', 'Other'];
var USER_ROLES = ['admin', 'receptionist'];

/**
 * One sheet (tab) per table. First row = headers. Column order matters.
 */
var SCHEMA = {
  Rooms: ['id', 'room_number', 'room_type', 'price_per_night', 'price_per_hour', 'floor',
    'capacity_adults', 'capacity_children', 'status', 'description', 'amenities',
    'created_at', 'updated_at'],

  Guests: ['id', 'full_name', 'mobile_number', 'email', 'address', 'city', 'state', 'country',
    'postal_code', 'id_type', 'id_number_masked', 'total_visits', 'notes',
    'created_at', 'updated_at'],

  Bookings: ['id', 'booking_number', 'guest_id', 'room_id', 'check_in_at', 'expected_check_out_at',
    'actual_check_out_at', 'stay_type', 'billing_type', 'rate_applied', 'units_booked',
    'total_charge', 'adults_count', 'children_count', 'status', 'special_notes', 'created_by',
    'created_at', 'updated_at'],

  Invoices: ['id', 'invoice_number', 'booking_id', 'guest_id', 'invoice_date', 'due_date',
    'room_charges', 'food_charges', 'service_charges', 'other_charges', 'discount_amount',
    'subtotal', 'tax_name', 'tax_rate', 'tax_amount', 'grand_total', 'paid_amount',
    'balance_amount', 'payment_status', 'primary_payment_method', 'hotel_snapshot', 'notes',
    'created_by', 'created_at', 'updated_at'],

  InvoiceItems: ['id', 'invoice_id', 'description', 'category', 'quantity', 'unit_price',
    'total_price', 'created_at', 'updated_at'],

  Payments: ['id', 'payment_number', 'invoice_id', 'booking_id', 'guest_id', 'amount',
    'payment_date', 'payment_method', 'transaction_reference', 'note', 'recorded_by',
    'created_at', 'updated_at'],

  Users: ['id', 'name', 'email', 'role', 'phone', 'is_active', 'password_hash', 'salt',
    'created_at', 'updated_at'],

  Settings: ['key', 'value'],

  ActivityLog: ['id', 'created_at', 'user_id', 'user_name', 'action', 'description',
    'subject_type', 'subject_id'],

  // Uploaded images (hotel logo, signature/stamp) stored as base64 split over several rows
  Assets: ['key', 'chunk', 'data']
};

var ASSET_KEYS = ['logo', 'signature'];

// Columns stored as numbers (everything else is stored as plain text).
var NUMERIC = {
  Rooms: ['id', 'price_per_night', 'price_per_hour', 'capacity_adults', 'capacity_children'],
  Guests: ['id', 'total_visits'],
  Bookings: ['id', 'guest_id', 'room_id', 'rate_applied', 'units_booked', 'total_charge',
    'adults_count', 'children_count', 'created_by'],
  Invoices: ['id', 'booking_id', 'guest_id', 'room_charges', 'food_charges', 'service_charges',
    'other_charges', 'discount_amount', 'subtotal', 'tax_rate', 'tax_amount', 'grand_total',
    'paid_amount', 'balance_amount', 'created_by'],
  InvoiceItems: ['id', 'invoice_id', 'quantity', 'unit_price', 'total_price'],
  Payments: ['id', 'invoice_id', 'booking_id', 'guest_id', 'amount', 'recorded_by'],
  Users: ['id'],
  Settings: [],
  ActivityLog: ['id', 'user_id', 'subject_id'],
  Assets: ['chunk']
};

var BOOLEAN = {
  Users: ['is_active']
};

var HEADER_COLORS = {
  Rooms: '#1e3a5f', Guests: '#1e3a5f', Bookings: '#1e3a5f', Invoices: '#1e3a5f',
  InvoiceItems: '#334155', Payments: '#334155', Users: '#7c2d12', Settings: '#7c2d12',
  ActivityLog: '#475569', Assets: '#475569'
};

var DEFAULT_SETTINGS = {
  hotel_name: 'Grand Horizon Hotel & Suites',
  address: '',
  city: '',
  state: '',
  country: 'India',
  postal_code: '',
  phone: '',
  email: '',
  website: '',
  gstin: '',
  invoice_prefix: 'INV-',
  next_invoice_number: '1001',
  tax_name: 'GST',
  tax_rate: '12',
  currency_symbol: '₹',
  default_check_in_time: '12:00',
  default_check_out_time: '11:00',
  footer_message: 'Thank you for staying with us!',
  terms_and_conditions: '',
  bank_name: '',
  bank_account_number: '',
  bank_ifsc: '',
  bank_upi_id: ''
};
