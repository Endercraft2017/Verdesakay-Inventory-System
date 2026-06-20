'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data.db');

const db = new DatabaseSync(DB_PATH);

// Pragmas for reliability + concurrency on a small LAN deployment.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      full_name     TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin','employee')),
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      sku           TEXT UNIQUE,
      category      TEXT,
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      quantity      INTEGER NOT NULL DEFAULT 0,
      unit          TEXT DEFAULT 'pcs',
      min_quantity  INTEGER NOT NULL DEFAULT 0,
      location      TEXT,
      notes         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id       INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      change        INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS forms (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      description   TEXT,
      category      TEXT,
      stored_name   TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT,
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject      TEXT,
      body         TEXT NOT NULL,
      read_at      TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
    CREATE INDEX IF NOT EXISTS idx_txn_item ON inventory_transactions(item_id);
    CREATE INDEX IF NOT EXISTS idx_items_dept ON inventory_items(department_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);

  seed();
}

function seed() {
  const deptCount = db.prepare('SELECT COUNT(*) AS c FROM departments').get().c;
  if (deptCount === 0) {
    const insertDept = db.prepare('INSERT INTO departments (name) VALUES (?)');
    for (const name of ['Administration', 'Operations', 'Finance', 'Human Resources', 'IT']) {
      insertDept.run(name);
    }
  }

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const adminDept = db.prepare('SELECT id FROM departments WHERE name = ?').get('Administration');
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(
      `INSERT INTO users (username, full_name, password_hash, role, department_id)
       VALUES (?, ?, ?, 'admin', ?)`
    ).run('admin', 'System Administrator', hash, adminDept ? adminDept.id : null);

    console.log('========================================================');
    console.log('  Default admin account created:');
    console.log('     username: admin');
    console.log(`     password: ${password}`);
    console.log('  >> Log in and change this password immediately. <<');
    console.log('========================================================');
  }
}

// Periodically clear expired sessions.
function cleanupSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Ensure the uploads directory exists.
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

module.exports = { db, init, cleanupSessions, newToken, UPLOAD_DIR, DB_PATH };
