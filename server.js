require('dotenv').config();

const path = require('path');
const express = require('express');
const { migrate } = require('./src/migrate');
const { apiKey } = require('./src/middleware/apiKey');
const resetRoutes = require('./src/routes/reset');
const slotRoutes = require('./src/routes/slots');
const bookingRoutes = require('./src/routes/bookings');

const app = express();

// Public routes: mounted before the key check so the page and health probe load without a key.
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.API_KEY=${JSON.stringify(process.env.API_KEY || '')};`);
});
app.use(express.static(path.join(__dirname, 'public')));

app.use(apiKey);
// Parse JSON only after auth, so a keyless request with a bad body still gets 401, not 400.
app.use(express.json());

app.use(resetRoutes);
app.use(slotRoutes);
app.use(bookingRoutes);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  console.error(err.stack || err);
  res.status(500).json({ error: 'internal error' });
});

async function main() {
  await migrate();
  const port = process.env.PORT || 3000;
  app.listen(port, '0.0.0.0', () => console.log(`listening on ${port}`));
}

main().catch((err) => {
  console.error('failed to start', err);
  process.exit(1);
});
