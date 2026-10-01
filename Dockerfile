# syntax=docker/dockerfile:1.7
#
# One image for all four NestJS services (api-gateway, auth-service,
# tenant-service, user-service). docker-compose.yml runs it four times with a
# different command. Build targets:
#
#   runtime (default) — compiled services + production dependencies only
#   tools             — full source + dev dependencies, for the db:* scripts
#                       (schema migrations, column sync) run with ts-node
#
# Build:  docker build -t hrms-backend .
#         docker build --target tools -t hrms-backend-tools .

ARG NODE_VERSION=24

# ── Base: Debian slim (glibc), so bcrypt's native binary installs cleanly ───
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# ── All dependencies (dev included) — for building and for the tools image ──
FROM base AS deps
# Compilers only in this stage, in case bcrypt has to build from source.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ── Compile every app ────────────────────────────────────────────────────────
FROM deps AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY apps ./apps
COPY libs ./libs
RUN npx nest build api-gateway \
 && npx nest build auth-service \
 && npx nest build tenant-service \
 && npx nest build user-service

# ── Production dependencies only ─────────────────────────────────────────────
FROM deps AS prod-deps
RUN --mount=type=cache,target=/root/.npm npm prune --omit=dev

# ── Tools: source + dev deps, for `npm run db:...` against the databases ─────
FROM deps AS tools
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY apps ./apps
COPY libs ./libs
ENV NODE_ENV=production
CMD ["npm", "run"]

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
# tini reaps zombies and forwards SIGTERM so Nest shuts down cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist

# Local file storage (used when STORAGE_PROVIDER=local) — mount a volume here.
RUN mkdir -p /app/uploads && chown node:node /app/uploads

USER node

# The image never contains .env files (see .dockerignore): every setting comes
# from the container environment, which also wins over any env file at runtime.
ENTRYPOINT ["/usr/bin/tini", "--"]
# Overridden per service in docker-compose.yml.
CMD ["node", "dist/apps/api-gateway/apps/api-gateway/src/main.js"]
