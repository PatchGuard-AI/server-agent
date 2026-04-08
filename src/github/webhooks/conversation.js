/**
 * Conversation helpers used by webhook handlers.
 *
 * What this file does:
 * - Fetches issue and review comments for a pull request.
 * - Builds a chronological plain-text conversation transcript.
 *
 * Exports:
 * - getAllPRComments(octokit, owner, repo, prNumber)
 * - buildConversation(comments)
 */

export async function getAllPRComments(octokit, owner, repo, prNumber) {
  const { data: issueComments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
  });

  const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
    owner,
    repo,
    pull_number: prNumber,
  });

  return [...issueComments, ...reviewComments].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );
}

export function buildConversation(comments) {
  return comments.map((c) => `${c.user.login}: ${c.body}`).join("\n");
}
