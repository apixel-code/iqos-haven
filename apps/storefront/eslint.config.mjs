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
            {
              group: ["next/cache"],
              message:
                "The API process is the sole catalogue cache owner (ADR 0022): no Next data cache or tags here.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        // Step 52 (ADR 0022): no second persistent cache in the storefront.
        {
          selector:
            "ExportNamedDeclaration VariableDeclarator[id.name='revalidate'], Property[key.name='revalidate']",
          message: "No ISR/time-based revalidation: storefront reads are request-time, no-store.",
        },
        {
          selector: "Property[key.name='cache'][value.value='force-cache']",
          message: 'Storefront fetches use cache: "no-store"; the API owns the catalogue cache.',
        },
        {
          selector: "ExpressionStatement[directive='use cache']",
          message: "No Next cache directives: the API owns the catalogue cache.",
        },
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
