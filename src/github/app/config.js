/**
 * GitHub App configuration and authenticated client bootstrap.
 *
 * This module is the single source of truth for creating the GitHub App client used
 * by the server. It performs all credential loading and validation in one place, then
 * exports a ready-to-use Octokit instance authenticated with `createAppAuth`.
 *
 * Environment variables required by this module:
 * - GITHUB_APP_ID: Numeric ID of the GitHub App.
 * - GITHUB_APP_INSTALLATION_ID: Installation ID that the app will act as.
 * - GITHUB_APP_PRIVATE_KEY: PEM private key string for the GitHub App.
 *
 * Notes:
 * - The private key commonly comes from `.env` with escaped newlines (`\\n`).
 *   This module normalizes that value to real newlines before authentication.
 * - Validation happens at startup so configuration issues fail fast and are easy
 *   to diagnose instead of surfacing later during API calls.
 */

import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

const APP_ID = process.env.GITHUB_APP_ID;
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
const PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;

if (!APP_ID || !INSTALLATION_ID || !PRIVATE_KEY) {
  throw new Error(
    "Missing required GitHub App env vars: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY",
  );
}

// Normalize escaped newlines for private keys stored in .env files.
const normalizedPrivateKey = PRIVATE_KEY.replace(/\\n/g, "\n");

// Create a single authenticated Octokit instance for GitHub App calls.
const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: APP_ID,
    privateKey: normalizedPrivateKey,
    installationId: Number(INSTALLATION_ID),
  },
});

export { octokit };
