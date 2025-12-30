const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "db.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    imagePath TEXT NOT NULL,
    thumbPath TEXT,
    displayPath TEXT,
    votes INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

// If you had older DB schema, add columns if missing
if (!columnExists("submissions", "thumbPath")) {
  db.exec(`ALTER TABLE submissions ADD COLUMN thumbPath TEXT;`);
}
if (!columnExists("submissions", "displayPath")) {
  db.exec(`ALTER TABLE submissions ADD COLUMN displayPath TEXT;`);
}

module.exports = { db };