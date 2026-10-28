import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// AUTH — password hashing, session tokens, login rate limiting.
//
// Passwords are hashed with scrypt (memory-hard, built into Node) using a
// per-user random salt. The plaintext password is never stored or logged.
// Verification uses timingSafeEqual so response time leaks nothing.
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  try {
    const test = crypto.scryptSync(String(password), String(salt), SCRYPT_KEYLEN);
    const known = Buffer.from(String(hash), 'hex');
    return known.length === test.length && crypto.timingSafeEqual(test, known);
  } catch {
    return false;
  }
}

export function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Simple fixed-window limiter: max `max` hits per `windowMs` per key.
export function createRateLimiter() {
  const hits = new Map();
  return function check(key, max, windowMs) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= max;
  };
}
