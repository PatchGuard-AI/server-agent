/**
 * Resolves the most recent tier assigned to a specific account.
 *
 * What this file does:
 * - Provides a data-access helper that reads tier records from SQLite.
 * - Looks up the latest non-null tier for an account ID + account name pair.
 *
 * Exports:
 * - getTierForAccount(accountId, accountName): Returns the latest tier string or null.
 *
 * Configuration and environment:
 * - Uses the shared database connector from ./db/config.js.
 * - No direct environment variables are read in this module.
 *
 * Important behavior notes:
 * - Results are ordered by created_at descending, so the newest row wins.
 * - Returns null when no matching tier is found.
 */

import { openDB } from "./db/config.js";

export async function getTierForAccount(accountId, accountName) {
  const db = await openDB();
  const row = await db.get(
    "SELECT tier FROM tiers WHERE account_id = ? AND tier IS NOT NULL AND account_name = ? ORDER BY created_at DESC LIMIT 1",
    accountId,
    accountName,
  );
  return row ? row.tier : null;
}
