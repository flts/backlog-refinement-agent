#!/usr/bin/env bash
# Dev check for deploy/keycloak/realms/backlog-realm.json.
# Starts a throwaway Keycloak container with the realm import (unless KC_URL points
# at a running instance), checks tokens/claims/endpoints and removes the container.
# Requires: docker, curl, jq.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${KC_IMAGE:-quay.io/keycloak/keycloak:26.6}"
CONTAINER="${KC_CONTAINER:-kc-realm-test}"
PORT="${KC_PORT:-18080}"
KC_URL="${KC_URL:-}"
REALM_URL=""
STARTED=0
FAILURES=0

cleanup() {
  if [[ "$STARTED" == 1 ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

decode_jwt_payload() {
  local part
  part="$(cut -d. -f2 <<<"$1" | tr '_-' '/+')"
  while (( ${#part} % 4 )); do part+="="; done
  base64 -d <<<"$part" 2>/dev/null || base64 --decode <<<"$part"
}

password_grant() {
  curl -s -d grant_type=password -d "client_id=$1" -d "username=$2" -d password=dev-password \
    "$REALM_URL/protocol/openid-connect/token"
}

if [[ -z "$KC_URL" ]]; then
  KC_URL="http://localhost:$PORT"
  echo "Starting $IMAGE as $CONTAINER on port $PORT ..."
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run --rm -d --name "$CONTAINER" -p "$PORT:8080" \
    -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
    -v "$SCRIPT_DIR/realms:/opt/keycloak/data/import:ro" \
    "$IMAGE" start-dev --import-realm >/dev/null
  STARTED=1
fi
REALM_URL="$KC_URL/realms/backlog"

echo "Waiting for $REALM_URL ..."
for _ in $(seq 1 90); do
  if curl -sf "$REALM_URL/.well-known/openid-configuration" >/dev/null; then break; fi
  sleep 2
done

echo "Endpoints"
discovery="$(curl -sf "$REALM_URL/.well-known/openid-configuration" || true)"
if [[ "$(jq -r .issuer <<<"$discovery" 2>/dev/null)" == "$REALM_URL" ]]; then
  pass "discovery document (issuer $REALM_URL)"
else
  fail "discovery document"
fi
jwks_uri="$(jq -r .jwks_uri <<<"$discovery" 2>/dev/null || true)"
if [[ -n "$jwks_uri" ]] && curl -sf "$jwks_uri" | jq -e '[.keys[] | select(.use == "sig" and .alg == "RS256")] | length > 0' >/dev/null; then
  pass "JWKS ($jwks_uri) has an RS256 signing key"
else
  fail "JWKS"
fi

echo "Verified users (backlog-dev-cli password grant)"
for user in alice bob carol; do
  token="$(password_grant backlog-dev-cli "$user@example.test" | jq -r '.access_token // empty')"
  if [[ -z "$token" ]]; then fail "$user: no access token"; continue; fi
  claims="$(decode_jwt_payload "$token")"
  if jq -e --arg email "$user@example.test" '
      (.aud | if type == "array" then . else [.] end) as $aud
      | ($aud | index("backlog-api")) != null
      and ($aud | index("agent-service")) != null
      and .email == $email
      and .email_verified == true
      and (.name | type == "string" and length > 0)
      and .preferred_username == "'"$user"'"' <<<"$claims" >/dev/null; then
    pass "$user: $(jq -c '{aud, email, email_verified, name, preferred_username, azp}' <<<"$claims")"
  else
    fail "$user: unexpected claims $(jq -c . <<<"$claims")"
  fi
done

echo "Unverified user"
token="$(password_grant backlog-dev-cli dave@example.test | jq -r '.access_token // empty')"
if [[ -n "$token" ]] && [[ "$(decode_jwt_payload "$token" | jq -r .email_verified)" == "false" ]]; then
  pass "dave: email_verified=false (services must reject with 403)"
else
  fail "dave: expected a token with email_verified=false"
fi

echo "agent-service service account (client credentials)"
sa_response="$(curl -s -d grant_type=client_credentials -d client_id=agent-service \
  -d client_secret=dev-agent-service-secret "$REALM_URL/protocol/openid-connect/token")"
sa_token="$(jq -r '.access_token // empty' <<<"$sa_response")"
if [[ -z "$sa_token" ]]; then
  fail "agent-service: no client-credentials token ($(jq -c . <<<"$sa_response"))"
else
  sa_claims="$(decode_jwt_payload "$sa_token")"
  if jq -e '
      (.aud | if type == "array" then . else [.] end) as $aud
      | ($aud | index("backlog-api")) != null and .azp == "agent-service"' <<<"$sa_claims" >/dev/null; then
    pass "agent-service: $(jq -c '{aud, azp, email}' <<<"$sa_claims")"
  else
    fail "agent-service: unexpected claims $(jq -c . <<<"$sa_claims")"
  fi
fi
error="$(curl -s -d grant_type=client_credentials -d client_id=agent-service -d client_secret=wrong \
  "$REALM_URL/protocol/openid-connect/token" | jq -r '.error // empty')"
if [[ "$error" == "unauthorized_client" || "$error" == "invalid_client" ]]; then
  pass "agent-service: wrong secret rejected ($error)"
else
  fail "agent-service: wrong secret was not rejected (error='$error')"
fi

echo "backlog-web must not allow the password grant"
error="$(password_grant backlog-web alice@example.test | jq -r '.error // empty')"
if [[ "$error" == "unauthorized_client" ]]; then
  pass "backlog-web password grant rejected ($error)"
else
  fail "backlog-web password grant was not rejected (error='$error')"
fi

echo "backlog-web requires PKCE"
code="$(curl -s -o /dev/null -w '%{http_code}' -G "$REALM_URL/protocol/openid-connect/auth" \
  --data-urlencode client_id=backlog-web --data-urlencode response_type=code \
  --data-urlencode scope=openid --data-urlencode redirect_uri=http://localhost:5173/)"
location="$(curl -s -o /dev/null -w '%{redirect_url}' -G "$REALM_URL/protocol/openid-connect/auth" \
  --data-urlencode client_id=backlog-web --data-urlencode response_type=code \
  --data-urlencode scope=openid --data-urlencode redirect_uri=http://localhost:5173/)"
if [[ "$location" == *"error=invalid_request"* && "$location" == *"code_challenge"* ]] || [[ "$code" == "400" ]]; then
  pass "authorization request without code_challenge rejected"
else
  fail "authorization request without code_challenge was not rejected (HTTP $code, $location)"
fi

if (( FAILURES > 0 )); then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "All checks passed"
