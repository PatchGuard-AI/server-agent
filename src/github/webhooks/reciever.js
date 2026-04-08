/**
 * Registers GitHub webhook handlers for PR comment workflows.
 *
 * What this file does:
 * - Subscribes to issue_comment and pull_request_review_comment events.
 * - Collects full PR conversation context from issue and review comments.
 * - Resolves the repository owner's service tier and executes the AI prompt.
 *
 * Exports:
 * - No direct exports. Importing this module attaches webhook listeners.
 *
 * Configuration and environment:
 * - Depends on shared webhook and Octokit clients from the webhooks config module.
 * - Uses BOT_NAME to identify bot-authored PRs/comments.
 *
 * Important behavior notes:
 * - Handlers ignore non-PR issue comments.
 * - AI execution is triggered only when bot ownership checks pass.
 * - Conversation context is ordered by creation timestamp before prompting.
 */

import { webhooks, octokit } from "./config.js";
import { getTierForAccount } from "../../tiers/fetcher.js";
import { executePrompt } from "../../ai/ollama/pr/reply.js";
import { saveConversationSnapshot } from "../../conversations/store.js";
import { getAllPRComments, buildConversation } from "./conversation.js";

// Handler for general PR comments
webhooks.on("issue_comment", async ({ payload }) => {
  if (!payload.issue.pull_request) {
    return;
  } // skip if not a PR

  const prOwner = payload.issue.user.login;
  const prNumber = payload.issue.number;
  const repo = payload.repository.name;
  const owner = payload.repository.owner.login;
  const commentAuthor = payload.comment.user.login;

  if (prOwner !== process.env.BOT_NAME) {
    console.log(`PR #${prNumber} is NOT from the bot. Owner: ${prOwner}`);
    return;
  }

  console.log(`PR #${prNumber} was created by the bot!`);

  if (commentAuthor === process.env.BOT_NAME) {
    console.log(`Comment also from the bot: ${commentAuthor}`);
    return;
  }

  console.log(`Comment from user ${commentAuthor}: ${payload.comment.body}`);

  const repoOwnerId = payload.repository.owner.id;
  const tier = await getTierForAccount(repoOwnerId, owner);
  const resolvedTier = tier ?? "free";

  // Fetch all comments and build conversation
  const allComments = await getAllPRComments(octokit, owner, repo, prNumber);
  const conversation = buildConversation(allComments);
  await saveConversationSnapshot({
    repoOwnerId,
    repoOwnerLogin: owner,
    repoName: repo,
    prNumber,
    eventType: "issue_comment",
    commentAuthor,
    conversation,
  });

  // Execute AI prompt using full conversation + tier
  const response = await executePrompt(conversation, resolvedTier);

  console.log(
    `AI response for PR #${prNumber} (tier: ${resolvedTier}): ${response}`
  );
});

// Handler for inline review comments
webhooks.on("pull_request_review_comment", async ({ payload }) => {
  const prOwner = payload.pull_request.user.login;
  const diffHunk = payload.comment.diff_hunk;
  const prNumber = payload.pull_request.number;
  const repo = payload.repository.name;
  const repoOwnerLogin = payload.repository.owner.login;
  const repoOwnerId = payload.repository.owner.id;
  const commentAuthor = payload.comment.user.login;

  console.log(`Repo owner: ${repoOwnerLogin}, ID: ${repoOwnerId}`);

  if (prOwner !== process.env.BOT_NAME) {
    console.log(
      `Inline comment on PR #${prNumber} NOT from the bot. PR owner: ${prOwner}`
    );
    return;
  }

  console.log(`Inline comment on PR #${prNumber} created by the bot!`);

  if (commentAuthor === process.env.BOT_NAME) {
    console.log(`Comment also from the bot: ${commentAuthor}`);
    return;
  }

  console.log(`Comment NOT from the bot: ${commentAuthor}`);

  const tier = await getTierForAccount(repoOwnerId, repoOwnerLogin);
  const resolvedTier = tier ?? "free";

  // Fetch all comments and build conversation
  const allComments = await getAllPRComments(
    octokit,
    repoOwnerLogin,
    repo,
    prNumber
  );
  const conversation = buildConversation(allComments);
  await saveConversationSnapshot({
    repoOwnerId,
    repoOwnerLogin,
    repoName: repo,
    prNumber,
    eventType: "pull_request_review_comment",
    commentAuthor,
    diffHunk,
    conversation,
  });

  // Execute AI prompt using full conversation + tier
  const response = await executePrompt(
    "This is the code you made: " +
      diffHunk +
      " This is the conversation: " +
      conversation,
    resolvedTier
  );

  console.log(
    `AI response for PR #${prNumber} (tier: ${resolvedTier}): ${response}`
  );
});

export { webhooks };
