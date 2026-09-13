import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const databasePath = process.env.DATABASE_PATH || "./data/game.db";
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK(role IN ('player','admin')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  year INTEGER NOT NULL,
  registration_open INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','finished')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS participants (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (competition_id, user_id)
);
CREATE TABLE IF NOT EXISTS riders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  team TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  UNIQUE (competition_id, normalized_name)
);
CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  starts_at TEXT,
  safety_closes_at TEXT,
  distance_threshold REAL DEFAULT 50,
  live_url TEXT,
  detected_km REAL,
  manual_closes_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','calculated','cancelled')),
  UNIQUE (competition_id, number)
);
CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_id INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),
  rider_id INTEGER NOT NULL REFERENCES riders(id),
  automatic INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(stage_id, user_id, slot),
  UNIQUE(stage_id, user_id, rider_id)
);
CREATE TABLE IF NOT EXISTS results (
  stage_id INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  rider_id INTEGER NOT NULL REFERENCES riders(id),
  position INTEGER NOT NULL CHECK(position > 0),
  PRIMARY KEY(stage_id, rider_id)
);
CREATE INDEX IF NOT EXISTS idx_bets_stage_user ON bets(stage_id, user_id);
CREATE INDEX IF NOT EXISTS idx_stages_competition ON stages(competition_id, number);
CREATE INDEX IF NOT EXISTS idx_riders_competition ON riders(competition_id, normalized_name);
`);
