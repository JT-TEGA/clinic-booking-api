require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { migrate } = require('./src/migrate');
const db = require('./src/db');
const { log, errorFields } = require('./src/lib/log');
const { apiKey } = require('./src/middleware/apiKey');
const resetRoutes = require('./src/routes/reset');
const slotRoutes = require('./src/routes/slots');
const bookingRoutes = require('./src/routes/bookings');

const SHUTDOWN_TIMEOUT_MS = 10000;
// Keep-alive probes every few minutes would bury the useful lines.
const UNLOGGED_PATHS = new Set(['/healthz', '/readyz']);
// Accept a caller's request id only if it is short and plain, so it can't smuggle junk into logs.
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const app = express();
app.disable('x-powered-by');

// One JSON line per request. Logs req.path (no query string), so emails in
// GET /bookings?email=… never reach the logs; bodies and headers aren't logged either.
app.use((req, res, next) => {
  const incoming = req.get('X-Request-Id');
  req.id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  if (UNLOGGED_PATHS.has(req.path)) return next();

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    log('info', 'request', {
      reqId: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
    });
  });
  next();
});

// Public routes: mounted before the key check so the page and health probes load without a key.
// /healthz is liveness (the process is up); /readyz is readiness (it can reach the database).
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/readyz', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ready: true });
  } catch (err) {
    res.status(503).json({ ready: false });
  }
});
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.API_KEY=${JSON.stringify(process.env.API_KEY || '')};`);
});
app.use(express.static(path.join(__dirname, 'public')));

app.use(apiKey);
// Parse JSON only after auth, so a keyless request with a bad body still gets 401, not 400.
app.use(express.json({ limit: '16kb' }));

app.use(resetRoutes);
app.use(slotRoutes);
app.use(bookingRoutes);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request body too large' });
  }
  log('error', 'unhandled error', { reqId: req.id, ...errorFields(err) });
  res.status(500).json({ error: 'internal error' });
});

// Render sends SIGTERM on every deploy: stop taking connections, let in-flight
// booking transactions finish, then drain the pool.
function handleShutdown(server) {
  let shuttingDown = false;
  return (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutdown started', { signal });

    const force = setTimeout(() => {
      log('error', 'shutdown timed out, forcing exit', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    server.close(async () => {
      try {
        await db.close();
        log('info', 'shutdown complete', { signal });
        process.exit(0);
      } catch (err) {
        log('error', 'pool close failed', errorFields(err));
        process.exit(1);
      }
    });
  };
}

async function main() {
  await migrate();
  const port = process.env.PORT || 3000;
  const server = app.listen(port, '0.0.0.0', () => log('info', 'listening', { port: Number(port) }));
  const onSignal = handleShutdown(server);
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

main().catch((err) => {
  log('error', 'failed to start', errorFields(err));
  process.exit(1);
});
