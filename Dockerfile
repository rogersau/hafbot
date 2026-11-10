# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable && corepack prepare pnpm@11.1.3 --activate
WORKDIR /workspace

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS production-dependencies
WORKDIR /runtime
COPY packages/node-runtime/package.json packages/node-runtime/pnpm-lock.yaml packages/node-runtime/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-prod,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts

FROM dependencies AS build
COPY . .
RUN pnpm run build

FROM ${NODE_IMAGE} AS runtime-base
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV HAF_ROLE=all
ENV HAF_STATIC_ROOT=/app/dist-admin
WORKDIR /app
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade --yes \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=production-dependencies --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/dist-node ./dist-node
COPY --from=build --chown=node:node /workspace/dist-admin ./dist-admin
COPY --from=build --chown=node:node /workspace/migrations/postgres ./migrations/postgres
COPY --from=production-dependencies --chown=node:node /runtime/package.json ./package.json
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node LICENSES ./LICENSES/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist-node/main.mjs"]

FROM build AS e2e-build
RUN pnpm run build:node:e2e

FROM runtime-base AS e2e
COPY --from=e2e-build --chown=node:node /workspace/dist-e2e ./dist-e2e
CMD ["node", "dist-e2e/main.mjs"]

# The default target remains the production image and excludes the E2E entrypoint.
FROM runtime-base AS runtime
