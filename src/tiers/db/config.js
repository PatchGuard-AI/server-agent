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

import sqlite3 from "sqlite3";
import { open } from "sqlite";

export async function openDB() {
  initializeDB().catch((err) => {
    console.error("Error initializing database:", err);
    throw err;
  });
  return (
    open({
      filename: "./database.db",
      driver: sqlite3.Database,
    }) ||
    (async () => {
      throw new Error("Failed to open database connection");
    })()
  );
}

export async function initializeDB() {
  const db = await openDB();
  await db.exec(`
  CREATE TABLE IF NOT EXISTS tiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_name TEXT NOT NULL,
    account_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
  `);
  return db;
}
