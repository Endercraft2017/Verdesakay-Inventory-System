'use strict';

const { db, newToken } = require('./db');

const SESSION_HOURS = 12;

function createSession(userId) {
  const token = newToken();
  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_HOURS} hours'))`
  ).run(token, userId);
  return token;
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Resolves the bearer token to the current user, or null.
function userFromToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role, u.department_id, u.active,
              d.name AS department_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE s.token = ? AND s.expires_at >= datetime('now')`
    )
    .get(token);
  if (!row || row.active !== 1) return null;
  return row;
}

function getToken(req) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

// Express middleware: require a logged-in user.
function requireAuth(req, res, next) {
  const user = userFromToken(getToken(req));
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  req.token = getToken(req);
  next();
}

// Express middleware factory: require a specific role.
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

module.exports = {
  createSession,
  destroySession,
  userFromToken,
  getToken,
  requireAuth,
  requireRole,
};
