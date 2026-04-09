/**
 * AI prompt execution layer for pull-request reply workflows.
 *
 * What this file does:
 * - Accepts a plain-text prompt and a service tier, then runs inference against
 *   the appropriate Ollama model and returns the generated text.
 * - Routes inference through the cluster coordinator when multiple nodes are
 *   registered, falling back to the local Ollama instance when running
 *   single-node.
 * - Implements a two-pass search-augmentation loop: if the model responds with
 *   a SEARCH_GOOGLE or SEARCH_WEBSITE directive the result is fetched and the
 *   prompt is re-executed with the retrieved content appended.
 *
 * Exports:
 * - executePrompt(prompt, tier): Runs inference and returns the AI response.
 * - ollama:                      Re-export of the shared local Ollama client.
 * - ollamaForHost(url):          Re-export of the per-host Ollama client factory.
 *
 * Configuration and environment:
 * - NODE_OLLAMA_PORT: local Ollama HTTP port. Default: 11434 (via config.js).
 * - OLLAMA_MANAGE: when "true", the cluster manages the Ollama subprocess.
 *
 * Important behavior notes:
 * - Throws when the prompt is empty, the tier is unknown, or the model returns
 *   an empty response.
 * - Cluster routing relies on getCoordinator() from the cluster bootstrap; if
 *   no coordinator is initialised the local Ollama client is used directly.
 * - The system prompt instructs the model to emit exactly one SEARCH_ directive
 *   per turn and nothing else; the loop depth is bounded by call-stack limits.
 */

import { ollama, ollamaForHost, OLLAMA_TIER_CONFIG } from "../config.js";
import { fetchSearchResults } from "../../../search/searxng.js";
import { getCoordinator } from "../../../cluster/index.js";

const SYSTEM_PROMPT = `You are an AI assistant for code generation and task execution. Respond only to the latest user message.

PRIORITY ORDER (highest → lowest):
1. Safety rules
2. Tool usage rules
3. Code rules
4. General behavior

GENERAL:
- Be concise, direct, and accurate.
- Do not add unnecessary text.
- Do not repeat yourself.
- Preserve user intent exactly.
- If unclear, ask a short clarification question.

CODE:
- Output clean, production-ready code.
- NO markdown code fences.
- NO explanations unless explicitly requested.
- Ensure correctness and best practices.

SEARCH TOOL (STRICT FORMAT):
- If external or up-to-date info is needed, USE SEARCH.
- Do NOT answer from memory if unsure.

- Output EXACTLY one of the following and NOTHING else:
  SEARCH_GOOGLE:<query>
  SEARCH_WEBSITE:<full_url>

- NO extra text.
- NO punctuation before or after.
- NO markdown.
- NO explanations.

- After search results are returned, answer normally.

FAILURE RULE:
- If you cannot answer and search is not useful:
  respond with: I don't know

SAFETY:
- Refuse harmful or illegal requests briefly.
- Do not generate unsafe or disallowed content.
`;

// ── Inference helpers ─────────────────────────────────────────────────────────

/**
 * Builds the standard message array for a prompt + tier.
 * @param {string} prompt
 * @returns {Array<{role: string, content: string}>}
 */
function buildMessages(prompt) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt.trim() },
  ];
}

/**
 * Runs inference on a single Ollama instance (local or remote).
 * @param {import('ollama').Ollama} client
 * @param {string}  model
 * @param {Array}   messages
 * @param {object}  options   num_predict, temperature, …
 * @returns {Promise<string>}
 */
async function runLocalOllama(client, model, messages, options) {
  const response = await client.chat({ model, messages, options });
  // The Ollama JS client v0.6+ returns the assistant message directly on
  // `response.message.content`.  The `choices[0].message.content` path is
  // kept as a fallback for older client versions or unexpected response shapes.
  const content =
    response.message?.content ?? response.choices?.[0]?.message?.content ?? "";
  return content.trim();
}

/**
 * Dispatches inference through the cluster.
 *
 * When multiple nodes are registered the coordinator's Ollama instance is
 * expected to have been started (or restarted) with `OLLAMA_RPC_SERVERS`
 * pointing at every worker's RPC port.  Ollama then distributes the model
 * layers across all available GPUs automatically – for example, running
 * qwen3-coder:480b (~240 GB at Q4) across 50 nodes × 8 GB = 400 GB of VRAM.
 *
 * With OLLAMA_MANAGE=true the agent manages the Ollama subprocess and handles
 * OLLAMA_RPC_SERVERS updates transparently whenever the cluster topology
 * changes.  Without it, the operator must configure OLLAMA_RPC_SERVERS on the
 * coordinator node's Ollama instance manually.
 *
 * @param {string} model
 * @param {Array}  messages
 * @param {object} options
 * @returns {Promise<string>}
 */
async function runClusterInference(model, messages, options) {
  const coordinator = getCoordinator();

  // If the coordinator has no remote peers, fall through to local Ollama.
  const pipelineUrls = coordinator.getPipelineUrls();
  if (pipelineUrls.length <= 1) {
    // Single node (this machine only) – use local client directly.
    return runLocalOllama(ollama, model, messages, options);
  }

  // Multi-node: route inference through the coordinator's local Ollama.
  // When OLLAMA_MANAGE=true, the local Ollama was (re)started with
  // OLLAMA_RPC_SERVERS listing every registered worker's RPC endpoint, so it
  // automatically shards the model across the cluster's combined VRAM.
  // When OLLAMA_MANAGE=false, the operator must configure OLLAMA_RPC_SERVERS
  // on the coordinator's Ollama instance manually before starting it; the
  // /cluster/rpc-config endpoint returns the correct value to use.
  const rpcServers = coordinator.getRpcServers();
  if (rpcServers.length > 0) {
    console.log(
      "[cluster] Routing inference through coordinator Ollama " +
        `(${pipelineUrls.length} node(s), ${rpcServers.length} RPC worker(s): ` +
        `${rpcServers.join(", ")})`
    );
  } else {
    console.warn(
      `[cluster] ${pipelineUrls.length} node(s) registered but none have an RPC port. ` +
        "Set NODE_OLLAMA_RPC_PORT on each worker and OLLAMA_MANAGE=true on the coordinator " +
        "to enable distributed model loading."
    );
  }

  try {
    return await runLocalOllama(ollama, model, messages, options);
  } catch (err) {
    console.error(
      "[cluster] Distributed inference failed. If the model is too large for the " +
        "cluster, ensure all worker nodes have NODE_OLLAMA_RPC_PORT set and the " +
        "coordinator has OLLAMA_MANAGE=true (or OLLAMA_RPC_SERVERS configured manually).",
      err.message
    );
    throw err;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Executes a prompt using the Ollama model and returns plain text output.
 *
 * Routes to the cluster coordinator when multiple nodes are available;
 * falls back to the local Ollama instance otherwise.
 *
 * @param {string} prompt - The input prompt to send to the model.
 * @param {"free"|"pro"|"enterprise"} [tier="free"] - Controls model selection and generation settings.
 * @returns {Promise<string>} - The generated text response from the model.
 * @throws {Error} - If the tier is unknown or the prompt is empty.
 */
async function executePrompt(prompt, tier = "free") {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("Prompt must be a non-empty string");
  }

  const tierConfig = OLLAMA_TIER_CONFIG[tier];
  if (!tierConfig) {
    throw new Error(`Unknown tier: ${tier}`);
  }

  const messages = buildMessages(prompt);
  const options = {
    num_predict: tierConfig.maxTokens,
    temperature: tierConfig.temperature,
  };

  const coordinator = getCoordinator();
  let fullResponse;

  if (coordinator) {
    fullResponse = await runClusterInference(
      tierConfig.model,
      messages,
      options
    );
  } else {
    fullResponse = await runLocalOllama(
      ollama,
      tierConfig.model,
      messages,
      options
    );
  }

  if (!fullResponse) {
    throw new Error("Received empty response from model");
  }

  if (fullResponse.includes("SEARCH_GOOGLE:")) {
    const query = fullResponse.split("SEARCH_GOOGLE:")[1].split("\n")[0].trim();
    if (!query) {
      throw new Error("Model returned SEARCH_GOOGLE: with no query");
    }
    const searchResults = await fetchSearchResults(query);
    return executePrompt(
      prompt + "\n\nSEARCH RESULTS:\n" + searchResults,
      tier
    );
  }

  if (fullResponse.includes("SEARCH_WEBSITE:")) {
    const url = fullResponse.split("SEARCH_WEBSITE:")[1].split("\n")[0].trim();
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      throw new Error(
        "Model returned SEARCH_WEBSITE: with a missing or invalid URL"
      );
    }
    const searchResults = await fetchSearchResults(url);
    return executePrompt(
      prompt + "\n\nSEARCH WEBSITE RESULTS:\n" + searchResults,
      tier
    );
  }

  return fullResponse;
}

export { executePrompt, ollama, ollamaForHost };
