# syntax=docker/dockerfile:1.7
# backlog-api container image. Build from the repository root:
#   docker build -f services/backlog-api/Dockerfile -t backlog-api .

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
COPY services/backlog-api/pyproject.toml services/backlog-api/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package backlog-api

# Then the workspace members this service needs.
COPY libs/py-skills libs/py-skills
COPY services/backlog-api services/backlog-api
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --package backlog-api

FROM ${PYTHON_IMAGE} AS runtime
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --no-create-home app
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BACKLOG_ALEMBIC_INI=/app/alembic.ini \
    BACKLOG_SKILLS_DIR=/app/skills
WORKDIR /app
COPY --from=build --chown=app:app /app/.venv /app/.venv
COPY --chown=app:app services/backlog-api/alembic.ini /app/alembic.ini
COPY --chown=app:app services/backlog-api/migrations /app/migrations
COPY --chown=app:app skills /app/skills
USER 10001:10001
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8001/healthz', timeout=2).status == 200 else 1)"]
CMD ["uvicorn", "backlog_api.main:app", "--host", "0.0.0.0", "--port", "8001", "--proxy-headers", "--no-access-log"]
