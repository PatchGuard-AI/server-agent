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
