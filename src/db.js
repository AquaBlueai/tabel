const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tabel.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    position TEXT DEFAULT '',
    department TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    telegram_id INTEGER UNIQUE,
    telegram_username TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', -- pending | active | inactive
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Бир ходим учун бир кунда битта ёзув: биринчи келиш ва охирги кетиш
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    date TEXT NOT NULL,          -- YYYY-MM-DD (маҳаллий вақт)
    check_in TEXT,               -- ISO UTC
    check_out TEXT,              -- ISO UTC
    in_lat REAL, in_lng REAL,
    out_lat REAL, out_lng REAL,
    edited_by_hr INTEGER NOT NULL DEFAULT 0,
    UNIQUE (employee_id, date)
  );

  -- HR қўлда қўядиган белгилар: таътил, касаллик, сафар ва ҳ.к.
  CREATE TABLE IF NOT EXISTS day_marks (
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    code TEXT NOT NULL,
    PRIMARY KEY (employee_id, date)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const DEFAULT_SETTINGS = {
  company_name: 'Компания',
  work_start: '09:00',
  work_end: '18:00',
  late_grace_min: '10',
  weekend_days: '0,6',      // 0 = якшанба, 6 = шанба
  holidays: '',             // вергул билан: 2026-01-01,2026-03-08
  office_lat: '',
  office_lng: '',
  office_radius_m: '200',   // бўш бўлса геолокация текширилмайди
  require_location: '0',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function saveSettings(obj) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (obj[key] !== undefined) stmt.run(key, String(obj[key]).trim());
  }
}

module.exports = { db, getSettings, saveSettings };
