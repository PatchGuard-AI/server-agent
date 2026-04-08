/**
 * This module is responsible for AI-powered execution using Ollama as the model backend.
 *
 * In plain terms, this file is where incoming prompts are turned into useful AI behavior:
 * - It can reply to a normal user message in a conversational way.
 * - It can also handle task-oriented prompts where the AI is expected to perform or guide
 *   a concrete action instead of just chatting.
 *
 * Ollama is used here as the local/hosted model interface, which means this file acts as
 * the bridge between our agentic logic and the model inference layer.
 *
 * If you are maintaining this file, think of it as the central execution point for
 * "ask AI to respond" and "ask AI to do work" flows.
 */

import { ollama, OLLAMA_TIER_CONFIG } from "../config.js";
import { fetchSearchResults } from "../../../search/searxng.js";

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

/**
 * Executes a prompt using the Ollama model and returns plain text output.
 * @param {string} prompt - The input prompt to send to the model.
 * @param {"free"|"pro"|"enterprise"} [tier="free"] - The service tier that controls model settings.
 * @returns {Promise<string>} - The generated text response from the model.
 * @throws {Error} - If the tier is unknown.
 */
async function executePrompt(prompt, tier = "free") {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("Prompt must be a non-empty string");
  }

  const tierConfig = OLLAMA_TIER_CONFIG[tier];

  if (!tierConfig) {
    throw new Error(`Unknown tier: ${tier}`);
  }

  const response = await ollama.chat({
    model: tierConfig.model,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: prompt.trim(),
      },
    ],
    options: {
      num_predict: tierConfig.maxTokens,
      temperature: tierConfig.temperature,
    },
  });

  let fullResponse = response.choices[0].message.content.trim();
  if (!fullResponse) {
    throw new Error("Received empty response from model");
  }
  if (fullResponse.includes("SEARCH_GOOGLE:")) {
    fullResponse = fullResponse.split("SEARCH_GOOGLE:")[1].trim();
    const query = fullResponse.split("\n")[0].trim();
    const searchResults = await fetchSearchResults(query);
    await executePrompt(prompt + "\n\nSEARCH RESULTS:\n" + searchResults, tier);
  }
  if (fullResponse.includes("SEARCH_WEBSITE:")) {
    fullResponse = fullResponse.split("SEARCH_WEBSITE:")[1].trim();
    const url = fullResponse.split("\n")[0].trim();
    const searchResults = await fetchSearchResults(url);
    await executePrompt(
      prompt + "\n\nSEARCH WEBSITE RESULTS:\n" + searchResults,
      tier
    );
  }

  return fullResponse;
}

export { executePrompt, ollama };
