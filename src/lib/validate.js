const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v) {
  return typeof v === 'string' ? v : '';
}

// Normalise first so validation, hashing and storage all see the same values.
function normaliseBooking(body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    slot_id: str(b.slot_id).trim(),
    name: str(b.name).trim(),
    email: str(b.email).trim().toLowerCase(),
  };
}

function isValidEmail(email) {
  return EMAIL_RE.test(email);
}

// Returns an error message, or null when the input is acceptable.
function validateBooking({ slot_id, name, email }) {
  if (!slot_id) return 'slot_id is required';
  if (!name) return 'name is required';
  if (!email) return 'email is required';
  if (!isValidEmail(email)) return 'email is invalid';
  return null;
}

module.exports = { normaliseBooking, isValidEmail, validateBooking };
