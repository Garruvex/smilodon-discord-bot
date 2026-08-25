FROM node:22-alpine AS build

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY drizzle.config.ts ./
COPY drizzle ./drizzle
COPY assets ./assets
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache libstdc++

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY --from=build /app/drizzle ./drizzle
# Repo-committed starter templates (config/examples/*) read at runtime by
# /settings chat template — see template-setting.ts. config/local (per-
# deployment guild data, not a template) stays excluded via .dockerignore.
COPY config ./config

USER node
CMD ["node", "dist/bootstrap/start.js"]
