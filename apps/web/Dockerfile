# Build context: repository root (docker build -f apps/web/Dockerfile .)
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apphost/package.json apphost/
RUN pnpm install --frozen-lockfile --filter @backlog/web...
COPY apps/web apps/web
RUN pnpm --filter @backlog/web build

FROM caddy:2-alpine
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
# Runtime configuration, served as /config.json by Caddy (not part of the build).
ENV LLM_ENDPOINT="" LLM_MODEL="" LLM_STREAMING="false"
EXPOSE 8080
