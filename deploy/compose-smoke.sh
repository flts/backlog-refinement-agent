#!/usr/bin/env bash
# End-to-end smoke test of the Docker Compose stack (docker-compose.yml). Requires curl and jq.
#
#   docker compose --profile fake up -d --build --wait
#   deploy/compose-smoke.sh
#
# Environment: WEB_URL (default http://localhost:8088), KC_URL (default http://localhost:8080; must be the URL the
# issuer is pinned to, so the token's `iss` matches), SMOKE_USER / SMOKE_PASSWORD (default alice@example.test / dev-password).
# The agent run assumes the fake gateway (it echoes); with a real LLM the run still has to emit RUN_STARTED/RUN_FINISHED.
set -euo pipefail

WEB_URL="${WEB_URL:-http://localhost:8088}"
KC_URL="${KC_URL:-http://localhost:8080}"
SMOKE_USER="${SMOKE_USER:-alice@example.test}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-dev-password}"
AGENT_ID="${AGENT_ID:-backlog-refiner}"
FAILURES=0

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { # check <description> <command...>
  local description="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi
}
die() { printf '  \033[31mFATAL\033[0m %s\n' "$1" >&2; exit 1; }

# api METHOD URL [json-body] -> prints the body, fails on HTTP >= 400
api() {
  local method="$1" url="$2" body="${3:-}" args=(-sS --fail-with-body -X "$1" -H "Authorization: Bearer $TOKEN")
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$url"
}

echo "== config"
CONFIG="$(curl -sS --fail "$WEB_URL/config.json")" || die "GET $WEB_URL/config.json failed (is the stack up?)"
jq -e '.auth.mode and .api.backlog == "/api/backlog" and .api.agent == "/api/agent" and .agentId' <<<"$CONFIG" >/dev/null \
  && pass "GET /config.json: $(jq -c .auth <<<"$CONFIG")" || fail "unexpected /config.json: $CONFIG"
check "SPA index is served" curl -sS --fail "$WEB_URL/"
check "unauthenticated /api/backlog/me is 401" test "$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL/api/backlog/me")" = 401

echo "== token"
TOKEN="$(curl -sS --fail-with-body \
  -d grant_type=password -d client_id=backlog-dev-cli -d "username=$SMOKE_USER" -d "password=$SMOKE_PASSWORD" \
  "$KC_URL/realms/backlog/protocol/openid-connect/token" | jq -r .access_token)"
[[ -n "$TOKEN" && "$TOKEN" != null ]] || die "no access token from $KC_URL"
ISS="$(cut -d. -f2 <<<"$TOKEN" | tr '_-' '/+' | awk '{ while (length($0) % 4) $0 = $0 "="; print }' | base64 -d | jq -r .iss)"
[[ "$ISS" == "$KC_URL/realms/backlog" ]] && pass "token issuer is $ISS" || fail "unexpected token issuer: $ISS"

echo "== backlog-api through the web proxy"
ME="$(api GET "$WEB_URL/api/backlog/me")" && pass "GET /api/backlog/me: $(jq -c . <<<"$ME")" || die "GET /me failed: $ME"
PROJECT="$(api POST "$WEB_URL/api/backlog/projects" "{\"name\":\"Smoke $(date +%s)\"}")" || die "create project failed: $PROJECT"
PROJECT_ID="$(jq -r .id <<<"$PROJECT")"; pass "created project $PROJECT_ID"
ITEM="$(api POST "$WEB_URL/api/backlog/projects/$PROJECT_ID/items" '{"type":"feature","title":"Smoke feature"}')" || die "create item failed: $ITEM"
ITEM_ID="$(jq -r .id <<<"$ITEM")"; pass "created item $ITEM_ID"
check "item is listed" bash -c "curl -sS --fail -H 'Authorization: Bearer $TOKEN' '$WEB_URL/api/backlog/projects/$PROJECT_ID/items' | grep -q '$ITEM_ID'"

echo "== agent-service through the web proxy"
check "GET /api/agent/agents lists $AGENT_ID" bash -c "curl -sS --fail -H 'Authorization: Bearer $TOKEN' '$WEB_URL/api/agent/agents' | grep -q '$AGENT_ID'"
THREAD="$(api POST "$WEB_URL/api/agent/threads" "{\"projectId\":\"$PROJECT_ID\",\"itemId\":\"$ITEM_ID\",\"title\":\"Smoke thread\"}")" || die "create thread failed: $THREAD"
THREAD_ID="$(jq -r .id <<<"$THREAD")"; pass "created thread $THREAD_ID"

RUN_BODY="$(jq -nc --arg t "$THREAD_ID" --arg p "$PROJECT_ID" --arg i "$ITEM_ID" '{
  threadId: $t, runId: ("smoke-" + $t), tools: [], context: [], forwardedProps: {},
  messages: [{id: "m-1", role: "user", content: "Say hello in one short sentence."}],
  state: {schemaVersion: 1, projectId: $p, itemId: $i, itemType: "feature", preview: null}}')"
EVENTS="$(curl -sS -N --max-time 120 -X POST "$WEB_URL/api/agent/agents/$AGENT_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: text/event-stream' -d "$RUN_BODY")" \
  || die "AG-UI run request failed"
TYPES="$(grep '^data:' <<<"$EVENTS" | sed 's/^data: *//' | jq -r .type | paste -sd' ' -)"
echo "  events: $TYPES"
tr ' ' '\n' <<<"$TYPES" | grep -q '^RUN_STARTED$' && pass "RUN_STARTED streamed through Caddy" || fail "no RUN_STARTED"
tr ' ' '\n' <<<"$TYPES" | grep -q '^RUN_FINISHED$' && pass "RUN_FINISHED streamed through Caddy" || fail "no RUN_FINISHED (RUN_ERROR?)"
tr ' ' '\n' <<<"$TYPES" | grep -q '^RUN_ERROR$' && fail "RUN_ERROR in stream: $(grep RUN_ERROR <<<"$EVENTS" | head -1)" || true

echo "== cleanup"
api DELETE "$WEB_URL/api/backlog/projects/$PROJECT_ID" >/dev/null && pass "deleted project $PROJECT_ID" || fail "delete project failed"

if (( FAILURES > 0 )); then echo "$FAILURES check(s) failed"; exit 1; fi
echo "Smoke test passed"
