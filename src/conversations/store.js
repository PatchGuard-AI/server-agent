/**
 * Persists PR conversation snapshots captured from webhook flows.
 *
 * What this file does:
 * - Stores full conversation text and event metadata in SQLite.
 *
 * Exports:
 * - saveConversationSnapshot(input): Inserts a conversation record.
 *
 * Configuration and environment:
 * - Uses the shared database connector from ../tiers/db/config.js.
 * - No direct environment variables are read in this module.
 *
 * Important behavior notes:
 * - Throws when required fields are missing.
 * - Keeps insertion logic centralized for webhook handlers.
 */

import { openDB } from "../tiers/db/config.js";

export async function saveConversationSnapshot({
  repoOwnerId,
  repoOwnerLogin,
  repoName,
  prNumber,
  eventType,
  commentAuthor,
  diffHunk = null,
  conversation,
}) {
  if (
    !repoOwnerId ||
    !repoOwnerLogin ||
    !repoName ||
    !eventType ||
    !commentAuthor ||
    typeof prNumber === "undefined" ||
    prNumber === null
  ) {
    throw new Error("Missing required conversation metadata");
  }

  if (typeof conversation !== "string" || conversation.trim().length === 0) {
    throw new Error("Conversation must be a non-empty string");
  }
  const normalizedPrNumber = Number(prNumber);
  if (!Number.isInteger(normalizedPrNumber) || normalizedPrNumber <= 0) {
    throw new Error("prNumber must be a positive integer");
  }

  const db = await openDB();
  db.run(
    `INSERT INTO conversations (
      repo_owner_id,
      repo_owner_login,
      repo_name,
      pr_number,
      event_type,
      comment_author,
      diff_hunk,
      conversation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    String(repoOwnerId),
    repoOwnerLogin,
    repoName,
    normalizedPrNumber,
    eventType,
    commentAuthor,
    diffHunk,
    conversation
  );
}
