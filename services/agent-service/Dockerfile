# syntax=docker/dockerfile:1.7
# agent-service container image. Build from the repository root:
#   docker build -f services/agent-service/Dockerfile -t agent-service .

ARG PYTHON_IMAGE=python:3.13-slim

FROM ${PYTHON_IMAGE} AS build
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /src

# Dependencies first (cached layer): only the workspace manifests and lockfile.
COPY pyproject.toml uv.lock ./
COPY libs/py-skills/pyproject.toml libs/py-skills/pyproject.toml
COPY libs/py-contracts/pyproject.toml libs/py-contracts/pyproject.toml
COPY services/agent-service/pyproject.toml services/agent-service/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package agent-service

# Then the workspace members this service needs.
COPY libs/py-skills libs/py-skills
COPY libs/py-contracts libs/py-contracts
COPY services/agent-service services/agent-service
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --package agent-service

FROM ${PYTHON_IMAGE} AS runtime
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --no-create-home app
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AGENT_ALEMBIC_INI=/app/alembic.ini \
    AGENT_SKILLS_DIR=/app/skills \
    AGENT_AGENTS_DIR=/app/agents \
    AGENT_TOOLS_FILE=/app/tools/tools.yaml \
    BACKLOG_SKILLS_DIR=/app/skills \
    BACKLOG_CONTRACTS_DIR=/app/contracts
WORKDIR /app
COPY --from=build --chown=app:app /app/.venv /app/.venv
COPY --chown=app:app services/agent-service/alembic.ini /app/alembic.ini
COPY --chown=app:app services/agent-service/migrations /app/migrations
COPY --chown=app:app services/agent-service/agents /app/agents
COPY --chown=app:app services/agent-service/tools/tools.yaml /app/tools/tools.yaml
COPY --chown=app:app skills /app/skills
COPY --chown=app:app contracts/schemas /app/contracts/schemas
USER 10001:10001
EXPOSE 8002
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8002/healthz', timeout=2).status == 200 else 1)"]
CMD ["uvicorn", "agent_service.main:app", "--host", "0.0.0.0", "--port", "8002", "--proxy-headers", "--no-access-log"]
