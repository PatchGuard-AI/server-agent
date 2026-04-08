/**
 * Initializes and exposes SQLite access helpers for tier storage.
 *
 * What this file does:
 * - Opens a SQLite database connection for the service.
 * - Ensures the tiers table exists before runtime access.
 *
 * Exports:
 * - openDB(): Opens and returns a database connection.
 * - initializeDB(): Creates required schema and returns a ready database handle.
 *
 * Configuration and environment:
 * - Uses a local database file at ./database.db.
 * - No direct environment variables are read in this module.
 *
 * Important behavior notes:
 * - Initialization errors are logged and rethrown.
 * - The tiers table stores account identity, tier value, and creation timestamp.
 */

import { DatabaseSync } from "node:sqlite";

let dbInstance;

export async function openDB() {
  if (!dbInstance) {
    try {
      const rawDb = new DatabaseSync("./database.db");
      rawDb.exec(`
  CREATE TABLE IF NOT EXISTS tiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_name TEXT NOT NULL,
    account_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, account_name, created_at)
    
  )
  `);

      dbInstance = {
        exec(sql) {
          rawDb.exec(sql);
        },
        get(sql, ...params) {
          return rawDb.prepare(sql).get(...params);
        },
      };
    } catch (err) {
      console.error("Error initializing database:", err);
      dbInstance = undefined;
      throw err;
    }
  }

  return dbInstance;
}

export async function initializeDB() {
  return openDB();
}
