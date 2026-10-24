// One JSON object per line on stdout, which Render captures as-is.
function log(level, msg, fields) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })}\n`);
}

// Message, code and stack only: pg errors carry the client and its connection
// parameters, which don't belong in logs.
function errorFields(err) {
  if (!err || typeof err !== 'object') return { error: String(err) };
  return { error: err.message, code: err.code, stack: err.stack };
}

module.exports = { log, errorFields };
