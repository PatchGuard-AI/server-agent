/**
 * ESLint configuration for the server-agent project.
 *
 * What this file does:
 * - Applies the recommended ESLint rule set to all JavaScript source files.
 * - Overrides specific rules to enforce project conventions:
 *     indent: 2 spaces, quotes: double, semi: required, no-var, prefer-const.
 * - Declares global variables available in the Node.js / browser-fetch runtime
 *   (console, process, fetch, setTimeout, etc.) to suppress no-undef errors.
 * - Applies CommonJS source-type to `.cjs` files only.
 * - Excludes generated and dependency directories (node_modules, dist, build).
 *
 * Important behavior notes:
 * - This file is consumed by `eslint` and `pnpm run lint` / `pnpm run lint:check`.
 * - Changing indent or quote rules here will cause formatting mismatches with
 *   the Prettier configuration; keep both tools aligned.
 */

import js from "@eslint/js";

export default [
  js.configs.recommended,

  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        module: "readonly",
        fetch: "readonly",
        require: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
      },
    },

    rules: {
      // Possible Errors
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-console": "off",

      // Best Practices
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-var": "error",
      "prefer-const": "error",

      // Style
      semi: ["error", "always"],
      quotes: ["error", "double"],
      indent: ["error", 2],
      "comma-dangle": ["error", "only-multiline"],

      // ES6+
      "arrow-body-style": ["error", "as-needed"],
      "prefer-arrow-callback": "error",
    },
  },

  // Node-specific overrides
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
    },
  },

  // Ignore patterns
  {
    ignores: ["node_modules", "dist", "build", "*.min.js"],
  },
];
