/**
 * Provides external search and direct URL fetch utilities for AI workflows.
 *
 * What this file does:
 * - Fetches raw page content when the input is a full http/https URL.
 * - Executes a SearXNG query for non-URL input and flattens results into plain text.
 *
 * Exports:
 * - fetchSearchResults(query): Returns text content from a URL or summarized SearXNG results.
 *
 * Configuration and environment:
 * - Uses public HTTP endpoints via fetch.
 * - No direct environment variables are read in this module.
 *
 * Important behavior notes:
 * - Throws when search responses are not successful or malformed.
 * - Keeps output text-oriented so callers can directly feed it into prompt flows.
 */

export async function fetchSearchResults(query) {
  if (query.startsWith("http://") || query.startsWith("https://")) {
    const content = await fetch(query).then((res) => res.text());
    return content;
  } else {
    const response = await fetch(
      `https://searx.party/search?q=${encodeURIComponent(query)}&format=json`,
    );
    if (!response.ok) {
      throw new Error(`Search request failed with status ${response.status}`);
    }
    const data = await response.json();
    if (!data.results || !Array.isArray(data.results)) {
      throw new Error("Invalid search response format");
    }
    return data.results
      .map((result) => `${result.title}: ${result.content}: ${result.url}`)
      .join("\n");
  }
}
