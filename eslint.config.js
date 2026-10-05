import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "release", "site/demo", "vendor", "node_modules", ".claude"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["engine/**/*.ts", "scripts/**/*.mjs", "tests/**/*.ts", "app/vite.config.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    // The video's stage page draws on a canvas in a hidden Electron window that also has Node.
    files: ["scripts/video/stage.mjs", "scripts/video/ground.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["app/**/*.{ts,tsx}"],
    ignores: ["app/vite.config.ts"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
