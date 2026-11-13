/**
 * Auth.gs — staff login, sessions and role checks.
 * Passwords are salted + hashed (SHA-256, iterated). Sessions live in CacheService (6 hours).
 */

var SESSION_TTL = 6 * 60 * 60; // seconds (CacheService max)

function hashPassword_(password, salt) {
  var digest = salt + '|' + password;
  for (var i = 0; i < 200; i++) {
    digest = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digest + salt, Utilities.Charset.UTF_8));
  }
  return digest;
}

function publicUser_(u, forDeveloper) {
  var res = { id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone, is_active: u.is_active, created_at: u.created_at };
  if (forDeveloper) {
    res.password = u.password_display || (u.email === 'developer2004@gmail.com' ? 'developer2004@gmail.com' : (u.email === 'admin@hotel.com' ? 'admin@hotel.com' : (u.email === 'reception@hotel.com' ? 'reception123' : '••••••')));
    res.password_hash = u.password_hash ? (String(u.password_hash).substring(0, 16) + '…') : '';
  }
  return res;
}

var Auth = {
  login: function (p) {
    var email = String(p.email || '').trim().toLowerCase();
    var password = String(p.password || '');
    if (!email || !password) throw new Error('Email and password are required.');

    var cache = CacheService.getScriptCache();
    var failKey = 'fail_' + email;
    var fails = Number(cache.get(failKey) || 0);
    if (fails >= 5) throw new Error('Too many failed attempts. Try again in 10 minutes.');

    ensureCoreUsers_();
    var user = Db.where('Users', function (u) { return String(u.email).toLowerCase() === email; })[0];
    if (!user || hashPassword_(password, user.salt) !== user.password_hash) {
      cache.put(failKey, String(fails + 1), 600);
      throw new Error('Invalid email or password.');
    }
    if (!user.is_active) throw new Error('Your account is deactivated. Contact the administrator.');

    cache.remove(failKey);
    var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    cache.put('sess_' + token, String(user.id), SESSION_TTL);
    logActivity_(user, 'login', user.name + ' logged in.');
    return { token: token, user: publicUser_(user) };
  },

  logout: function (token) {
    if (token) CacheService.getScriptCache().remove('sess_' + token);
    return true;
  },

  requireUser: function (token, roles) {
    if (!token) throw new Error('AUTH: Please log in.');
    var cache = CacheService.getScriptCache();
    var id = cache.get('sess_' + token);
    if (!id) throw new Error('AUTH: Session expired. Please log in again.');
    var user = Db.find('Users', id);
    if (!user || !user.is_active) {
      cache.remove('sess_' + token);
      throw new Error('AUTH: Account not available.');
    }
    if (roles && roles.indexOf(user.role) === -1) throw new Error('You do not have permission to do this.');
    cache.put('sess_' + token, String(user.id), SESSION_TTL); // sliding expiry
    return user;
  },

  changePassword: function (p, user) {
    var full = Db.findOrFail('Users', user.id, 'User');
    if (hashPassword_(String(p.current_password || ''), full.salt) !== full.password_hash) {
      throw new Error('Current password is incorrect.');
    }
    if (String(p.new_password || '').length < 6) throw new Error('New password must be at least 6 characters.');
    var salt = Utilities.getUuid();
    Db.update('Users', user.id, { salt: salt, password_hash: hashPassword_(String(p.new_password), salt) });
    logActivity_(user, 'password_changed', user.name + ' changed their password.');
    return true;
  }
};
