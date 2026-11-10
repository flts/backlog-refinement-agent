FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
# Runtime configuration, served as /config.json by Caddy (not part of the build).
ENV LLM_ENDPOINT="" LLM_MODEL="" LLM_STREAMING="false"
EXPOSE 8080
