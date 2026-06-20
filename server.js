'use strict';

const path = require('path');
const os = require('os');
const express = require('express');
const { init, cleanupSessions } = require('./src/db');

init();
setInterval(cleanupSessions, 60 * 60 * 1000).unref(); // hourly

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Small request logger.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
    }
  });
  next();
});

// API routes
app.use('/api/auth', require('./src/routes/auth.routes'));
app.use('/api/users', require('./src/routes/users.routes'));
app.use('/api/inventory', require('./src/routes/inventory.routes'));
app.use('/api/forms', require('./src/routes/forms.routes'));
app.use('/api/messages', require('./src/routes/messages.routes'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback for non-API GET requests.
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Central error handler.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lanIps = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) lanIps.push(net.address);
    }
  }
  console.log('\nVerdesakay Office System is running:');
  console.log(`   Local:   http://localhost:${PORT}`);
  for (const ip of lanIps) console.log(`   Network: http://${ip}:${PORT}  (for other office PCs)`);
  console.log('');
});
