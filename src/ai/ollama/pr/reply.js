/**
 * This module is responsible for AI-powered execution using Ollama as the model backend.
 *
 * In plain terms, this file is where incoming prompts are turned into useful AI behavior:
 * - It can reply to a normal user message in a conversational way.
 * - It can also handle task-oriented prompts where the AI is expected to perform or guide
 *   a concrete action instead of just chatting.
 *
 * Inference routing:
 * - When a cluster is available (multiple nodes discovered at startup), inference is
 *   dispatched through the coordinator, which splits the work across cluster nodes via
 *   WebSocket and routes the request to the appropriate Ollama instance.
 * - When no cluster peers are present the request falls back to the local Ollama instance.
 *
 * If you are maintaining this file, think of it as the central execution point for
 * "ask AI to respond" and "ask AI to do work" flows.
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
  // The Ollama JS client returns `message.content` on the top-level response,
  // not nested under `choices[0]`.
  const content =
    response.message?.content ?? response.choices?.[0]?.message?.content ?? "";
  return content.trim();
}

/**
 * Dispatches inference through the cluster coordinator.
 * Each registered node receives an INFERENCE_REQUEST and the first to respond
 * wins (round-robin / first-available semantics).
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
    // Single node (this machine only) – use local client directly to avoid
    // the WebSocket round-trip overhead.
    return runLocalOllama(ollama, model, messages, options);
  }

  console.log(
    `[cluster] Dispatching inference across ${
      pipelineUrls.length
    } node(s): ${pipelineUrls.join(", ")}`
  );

  try {
    return await coordinator.dispatchInference({ model, messages, options });
  } catch (err) {
    console.error(
      "[cluster] Distributed inference failed, falling back to local:",
      err.message
    );
    return runLocalOllama(ollama, model, messages, options);
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
    const searchResults = await fetchSearchResults(query);
    return executePrompt(
      prompt + "\n\nSEARCH RESULTS:\n" + searchResults,
      tier
    );
  }

  if (fullResponse.includes("SEARCH_WEBSITE:")) {
    const url = fullResponse.split("SEARCH_WEBSITE:")[1].split("\n")[0].trim();
    const searchResults = await fetchSearchResults(url);
    return executePrompt(
      prompt + "\n\nSEARCH WEBSITE RESULTS:\n" + searchResults,
      tier
    );
  }

  return fullResponse;
}

export { executePrompt, ollama, ollamaForHost };
