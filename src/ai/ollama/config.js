/**
 * Central Ollama configuration for AI execution.
 *
 * What this file does:
 * - Creates and exports a shared Ollama client instance.
 * - Defines tier-specific model and generation settings used by execution flows.
 *
 * Exports:
 * - ollama: Shared Ollama client used across AI modules.
 * - OLLAMA_TIER_CONFIG: Tier-to-model settings map.
 *
 * Configuration and environment:
 * - Requires Ollama runtime availability where this service executes.
 * - No direct environment variables are read in this module.
 *
 * Important behavior notes:
 * - maxTokens is consumed by callers and mapped to Ollama num_predict.
 * - temperature controls deterministic vs creative output by tier.
 */

import { Ollama } from "ollama";

// Single Ollama client instance shared across AI execution calls.
const ollama = new Ollama();

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

export { ollama, OLLAMA_TIER_CONFIG };
