#!/usr/bin/env bash
# Runs once on first start of the postgres container (docker-entrypoint-initdb.d).
# Creates one database and one owner role per service and enables the extensions the migrations need.
set -euo pipefail

create_database() {
  local database="$1" role="$2" password="$3"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v role="$role" -v password="$password" -v db="$database" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role') \gexec
SQL
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$database" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
}

create_database backlogdb backlog "${BACKLOG_DB_PASSWORD:?}"
create_database agentdb agent "${AGENT_DB_PASSWORD:?}"
