# Release images (roadmap step 122, ADR 0100). Build once per commit in CI, push by digest and
# promote the same digests; never rebuild between staging and production.
#
#   docker build -f infra/docker/Dockerfile --target <api|worker|migrate|storefront|admin> .
#
# Every runtime image runs as the unprivileged `node` user with only production dependencies.
# No .env, secrets or demo data enter a layer (see .dockerignore); configuration is runtime env.

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
# openssl: Prisma's schema engine (migrate image); ca-certificates: TLS to S3/SMTP/Sentry.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm exec turbo run build --concurrency=2 \
  && pnpm --filter @ih/api deploy --legacy --prod /out/api \
  && pnpm --filter @ih/worker deploy --legacy --prod /out/worker \
  && pnpm --filter @ih/db deploy --legacy /out/migrate \
  && pnpm --filter @ih/config deploy --legacy --prod /out/config \
  && for app in storefront admin; do \
       mkdir -p /out/$app/node_modules/@ih \
       && cp -a apps/$app/.next/standalone/. /out/$app/ \
       && cp -a /out/config /out/$app/node_modules/@ih/config \
       && cp -a apps/$app/.next/static /out/$app/apps/$app/.next/static \
       && cp infra/docker/next-start.cjs /out/$app/apps/$app/start.cjs; \
     done

FROM base AS runtime
ENV NODE_ENV=production
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM runtime AS api
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
EXPOSE 4000
CMD ["node", "dist/main.js"]

FROM runtime AS worker
WORKDIR /app
COPY --from=build --chown=node:node /out/worker ./
CMD ["node", "dist/main.js"]

# Applies reviewed migrations with the migration identity, then exits (`node dist/migrate.js`).
FROM runtime AS migrate
WORKDIR /app
COPY --from=build --chown=node:node /out/migrate ./
CMD ["node", "dist/migrate.js"]

FROM runtime AS storefront
WORKDIR /app
COPY --from=build --chown=node:node /out/storefront ./
ENV IH_NEXT_APP=storefront
EXPOSE 3000
CMD ["node", "apps/storefront/start.cjs"]

FROM runtime AS admin
WORKDIR /app
COPY --from=build --chown=node:node /out/admin ./
ENV IH_NEXT_APP=admin
EXPOSE 3001
CMD ["node", "apps/admin/start.cjs"]
