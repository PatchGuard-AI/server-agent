/**
 * Central Ollama configuration for AI execution.
 *
 * What this file does:
 * - Creates and exports a shared Ollama client instance (used for single-node
 *   or local-fallback inference).
 * - Defines tier-specific model and generation settings used by execution flows.
 * - Exports a factory that returns an Ollama client pointed at a specific host,
 *   allowing the cluster layer to route requests to individual worker nodes.
 *
 * Exports:
 * - ollama:              Shared Ollama client (points to local Ollama instance).
 * - ollamaForHost(url):  Returns an Ollama client configured for the given URL.
 * - OLLAMA_TIER_CONFIG:  Tier-to-model settings map.
 *
 * Configuration and environment:
 * - NODE_OLLAMA_PORT: local Ollama HTTP port. Default: 11434.
 * - No other environment variables are read in this module.
 *
 * Important behavior notes:
 * - maxTokens is consumed by callers and mapped to Ollama num_predict.
 * - temperature controls deterministic vs creative output by tier.
 */

import { Ollama } from "ollama";

// Single Ollama client instance for local / single-node access.
const ollama = new Ollama({
  host: `http://localhost:${process.env.NODE_OLLAMA_PORT ?? 11434}`,
});

/**
 * Returns an Ollama client configured to call the given base URL.
 * Used by the distributed inference layer to target specific worker nodes.
 *
 * @param {string} hostUrl  e.g. "http://192.168.1.5:11434"
 * @returns {Ollama}
 */
function ollamaForHost(hostUrl) {
  return new Ollama({ host: hostUrl });
}

const OLLAMA_TIER_CONFIG = {
  free: {
    model: "qwen3-coder:30b",
    maxTokens: 1000,
    temperature: 0.7,
  },
  pro: {
    model: "codellama:70b",
    maxTokens: 2000,
    temperature: 0.5,
  },
  enterprise: {
    model: "qwen3-coder:480b",
    maxTokens: 5000,
    temperature: 0.3,
  },
};

export { ollama, ollamaForHost, OLLAMA_TIER_CONFIG };
