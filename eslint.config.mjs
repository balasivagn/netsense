import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    files: ["scripts/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/_generated/**",
      "**/gen/**",
      ".orca-scratch/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
);
