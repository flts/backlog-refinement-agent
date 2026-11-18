# Build context: repository root (docker build -f apps/web/Dockerfile .)
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY apps/web/package.json apps/web/
COPY apphost/package.json apphost/
RUN pnpm install --frozen-lockfile --filter @backlog/web...
COPY contracts contracts
COPY apps/web apps/web
RUN pnpm --filter @backlog/web build

FROM caddy:2-alpine
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
# Runtime configuration, served as /config.json by Caddy (not part of the build). OIDC_AUTHORITY is required for
# AUTH_MODE=oidc; BACKLOG_API_URL and AGENT_API_URL are the upstreams of /api/backlog and /api/agent.
ENV AUTH_MODE="oidc" OIDC_AUTHORITY="" OIDC_CLIENT_ID="backlog-web" OIDC_SCOPE="openid profile email" AGENT_ID="backlog-refiner" \
    BACKLOG_API_URL="http://backlog-api:8001" AGENT_API_URL="http://agent-service:8002"
EXPOSE 8080
