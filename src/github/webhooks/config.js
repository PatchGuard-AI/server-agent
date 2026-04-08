/**
 * GitHub Webhooks configuration and verifier bootstrap.
 *
 * This module initializes the shared `Webhooks` instance used to validate and
 * process incoming GitHub webhook events. The secret loaded here must match the
 * webhook secret configured in your GitHub App or repository webhook settings.
 *
 * Environment variables required by this module:
 * - GITHUB_WEBHOOK_SECRET: Shared secret used to verify webhook signatures.
 *
 * Notes:
 * - Validation happens at startup so missing configuration fails fast.
 * - The created `webhooks` instance should be reused by request handlers to
 *   ensure consistent signature verification behavior across the app.
 */

import { Webhooks } from "@octokit/webhooks";
import { octokit } from "../app/config.js";

// Ensure required webhook signing secret exists before initializing handlers.
if (!process.env.GITHUB_WEBHOOK_SECRET) {
  throw new Error("Missing required env var: GITHUB_WEBHOOK_SECRET");
}

// Create the shared webhook verifier/dispatcher with the configured secret.
const webhooks = new Webhooks({
  secret: process.env.GITHUB_WEBHOOK_SECRET,
});

export { webhooks, octokit };
