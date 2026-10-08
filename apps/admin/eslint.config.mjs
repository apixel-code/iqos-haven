import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "next-env.d.ts"]),
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@ih/db",
                "@ih/application",
                "@ih/api",
                "@ih/worker",
                "pg",
                "@prisma/*",
                "**/db/**",
                "**/application/**",
                "**/api/**",
                "**/worker/**",
              ],
              message:
                "Front ends access commerce through contracts/gateway, never DB or business services.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: "No Math.random (prototype trap).",
        },
        {
          selector: "MemberExpression[object.name='sessionStorage']",
          message:
            "No sessionStorage: age state is a server-signed cookie; checkout PII is memory-only.",
        },
      ],
    },
  },
]);
