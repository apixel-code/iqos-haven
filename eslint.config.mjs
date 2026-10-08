import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
const apps = ["@ih/api", "@ih/worker", "@ih/storefront", "@ih/admin", "**/apps/**"];
const infra = [
  "@ih/db",
  "@ih/config",
  "@ih/logger",
  "@ih/ui-core",
  "@ih/tokens",
  "pg",
  "prisma",
  "@prisma/*",
  "@nestjs/*",
  "next",
  "next/*",
  "**/db/**",
  "**/config/**",
  "**/logger/**",
];
const ban = (group) => [
  "error",
  { patterns: [{ group, message: "Import crosses the permitted package boundary." }] },
];
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/next-env.d.ts",
      "**/src/generated/**",
      "**/migrations/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: "Use crypto randomness, never prototype Math.random.",
        },
      ],
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    files: ["packages/**"],
    ignores: ["packages/domain/**", "packages/contracts/**", "packages/application/**"],
    rules: { "no-restricted-imports": ban(apps) },
  },
  {
    files: ["packages/domain/**", "packages/contracts/**"],
    rules: {
      "no-restricted-imports": ban([...apps, ...infra, "@ih/application", "**/application/**"]),
    },
  },
  {
    files: ["packages/application/**"],
    rules: { "no-restricted-imports": ban([...apps, ...infra]) },
  },
);
