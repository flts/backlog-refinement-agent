# Keycloak realm `backlog` (local development)

`realms/backlog-realm.json` is a Keycloak 26.x realm export. It is imported with
`start-dev --import-realm` (image `quay.io/keycloak/keycloak:26.6`) by the Aspire AppHost
(`withRealmImport('../deploy/keycloak/realms')`) and by `docker compose`. It contains **no
production secrets**. The admin user is not part of the realm. Aspire and compose set it
through `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD`.

> This realm is for local development and tests. For a shared or production realm, remove
> `backlog-dev-cli` and the test users, turn on `verifyEmail` with SMTP, and narrow the
> redirect URIs to the real hostnames.

## Realm settings

| Setting | Value | Why |
|---|---|---|
| `loginWithEmailAllowed` | `true` | Users sign in with their email address |
| `duplicateEmailsAllowed` | `false` | Project access is granted by email, so emails must be unique |
| `registrationAllowed` | `false` | Accounts are managed in Keycloak only |
| `verifyEmail` | `false` (dev) | No SMTP in dev. All test users except `dave` are pre-verified |
| `accessTokenLifespan` | 600 s (10 min) | Short-lived access tokens; the SPA renews silently |
| `ssoSessionIdleTimeout` / `ssoSessionMaxLifespan` | 2 h / 10 h | A dev session survives a working day |

The services reject tokens without `email` or with `email_verified=false` (`403`).

## Clients

| Client | Type | Flows | Purpose |
|---|---|---|---|
| `backlog-web` | public | Authorization Code + **PKCE S256 required**. No password grant, no implicit flow | The SPA (`auth.mode = oidc`, oidc-client-ts) |
| `backlog-dev-cli` | public | **Password grant only** (Resource Owner Password) | **DEV/TEST ONLY.** Scripts, e2e tests, curl |
| `backlog-api` | bearer-only | none | Audience/resource of backlog-api |
| `agent-service` | confidential, service account | **Client credentials** only (no standard, implicit or password flow) | Audience/resource of agent-service **and** the credential agent-service uses for backlog-api's internal event stream (`/api/backlog/internal/events`) |

`backlog-web` and `backlog-dev-cli` each have two `oidc-audience-mapper`s. These add
`backlog-api` and `agent-service` to `aud` of the access token. One SPA token therefore works
for both services, and agent-service can forward the user's token to the backlog MCP server.
The `profile` and `email` default scopes provide `name`, `given_name`, `family_name`,
`preferred_username`, `email` and `email_verified`.

The `agent-service` client has `serviceAccountsEnabled: true`, the **dev-only** secret
`dev-agent-service-secret` and an `oidc-audience-mapper` for `backlog-api`. Its client-credentials
tokens therefore have `aud` containing `backlog-api` and `azp = agent-service`; backlog-api accepts them on
`/internal/*` when `BACKLOG_INTERNAL_CLIENT_IDS` contains `agent-service`. Replace the secret in any
shared environment (`AGENT_SERVICE_CLIENT_SECRET`). The client stays usable as a resource audience
for user tokens (the `backlog-web` / `backlog-dev-cli` audience mappers are unchanged).

```bash
curl -s -d grant_type=client_credentials -d client_id=agent-service -d client_secret=dev-agent-service-secret \
  http://localhost:8080/realms/backlog/protocol/openid-connect/token | jq -r .access_token
```

Example access token payload (alice):

```json
{
  "iss": "http://localhost:18080/realms/backlog",
  "aud": ["backlog-api", "agent-service"],
  "azp": "backlog-web",
  "typ": "Bearer",
  "scope": "openid email profile",
  "email": "alice@example.test",
  "email_verified": true,
  "name": "Alice Owner",
  "preferred_username": "alice",
  "given_name": "Alice",
  "family_name": "Owner"
}
```

Services validate `iss`, `aud` (their own client id), `exp` and the signature (RS256, JWKS at
`<issuer>/protocol/openid-connect/certs`).

### Redirect URIs of `backlog-web`

Keycloak does not support port wildcards (`http://localhost:*`), so common dev ports are listed
explicitly:

- `http://localhost:5173/*` and `http://127.0.0.1:5173/*` (Vite dev server)
- `http://localhost:4173/*` and `http://127.0.0.1:4173/*` (Vite preview)
- `http://localhost:8080/*` and `http://localhost:8088/*` (Caddy / docker compose)

Web origins are `+` (all redirect URI origins are allowed for CORS) and post-logout redirect
URIs are `+` (same as the redirect URIs).

**Aspire assigns ports.** If the `web` resource runs on another port (see the Aspire dashboard),
pin the port in the AppHost (for example `withHttpEndpoint({ port: 5173 })`) or add the URL to
the client:

1. Add `"http://localhost:<port>/*"` to `clients[backlog-web].redirectUris` in
   `realms/backlog-realm.json`.
2. Re-import the realm. The import uses the `IGNORE_EXISTING` strategy, so an existing realm is
   **not** updated: remove the Keycloak data volume/container (or the realm in the admin
   console) and restart.

For a quick, temporary change, use the admin console: *Clients → backlog-web → Valid redirect
URIs*.

## Test users

All users have the password `dev-password` (not temporary) and are enabled.

| Username | Email | Name | `emailVerified` | Use in tests |
|---|---|---|---|---|
| `alice` | `alice@example.test` | Alice Owner | `true` | Project owner |
| `bob` | `bob@example.test` | Bob Contributor | `true` | Contributor |
| `carol` | `carol@example.test` | Carol Outsider | `true` | Not a member (expects `403`/`404`) |
| `dave` | `dave@example.test` | Dave Unverified | **`false`** | Must be rejected (unverified email) |

Users can sign in with their username or their email address.

## Getting a token (dev only)

```bash
curl -s \
  -d grant_type=password -d client_id=backlog-dev-cli \
  -d username=alice@example.test -d password=dev-password \
  http://localhost:8080/realms/backlog/protocol/openid-connect/token | jq -r .access_token
```

Use the Keycloak port from the Aspire dashboard or compose instead of `8080` if it differs.

### Issuer and hostnames

The `iss` claim follows the hostname the token was requested on (`start-dev` has no fixed
hostname). A token fetched via `http://localhost:8080` has
`iss = http://localhost:8080/realms/backlog`. Services that reach Keycloak through another
hostname (for example `http://keycloak:8080` inside compose) must still expect the browser-facing
issuer. Configure the expected issuer explicitly, or set `KC_HOSTNAME` on Keycloak.

## Dev check

`check-realm.sh` starts a throwaway Keycloak with this realm and checks it. Requirements:
`docker`, `curl` and `jq`.

```bash
deploy/keycloak/check-realm.sh                         # starts kc-realm-test on :18080, removes it afterwards
KC_URL=http://localhost:8080 deploy/keycloak/check-realm.sh   # check an already running Keycloak
```

It verifies:

- The OIDC discovery document (issuer) and JWKS (RS256 signing key) respond.
- `alice`, `bob` and `carol` get tokens via `backlog-dev-cli` with `aud ⊇ {backlog-api,
  agent-service}`, the correct `email`, `email_verified=true`, `name` and `preferred_username`.
- The `agent-service` client gets a client-credentials token with `aud ∋ backlog-api` and
  `azp = agent-service`; a wrong secret is rejected.
- The `agent-service` client gets a client-credentials token with `aud ∋ backlog-api` and
  `azp = agent-service`; a wrong secret is rejected.
- `dave` gets a token with `email_verified=false`.
- `backlog-web` rejects the password grant (`unauthorized_client`).
- `backlog-web` rejects an authorization request without `code_challenge`.

The equivalent manual steps:

```bash
docker run --rm -d --name kc-realm-test -p 18080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -v "$PWD/deploy/keycloak/realms:/opt/keycloak/data/import:ro" \
  quay.io/keycloak/keycloak:26.6 start-dev --import-realm

R=http://localhost:18080/realms/backlog
until curl -sf "$R/.well-known/openid-configuration" >/dev/null; do sleep 2; done

curl -s "$R/.well-known/openid-configuration" | jq '{issuer, jwks_uri}'
curl -s "$R/protocol/openid-connect/certs" | jq '.keys[] | {kid, alg, use}'

decode() { p=$(cut -d. -f2 <<<"$1" | tr '_-' '/+'); while (( ${#p} % 4 )); do p+="="; done; base64 -d <<<"$p"; }
token() { curl -s -d grant_type=password -d client_id="$1" -d username="$2" -d password=dev-password \
  "$R/protocol/openid-connect/token"; }

decode "$(token backlog-dev-cli alice@example.test | jq -r .access_token)" \
  | jq '{aud, email, email_verified, name, preferred_username}'
decode "$(token backlog-dev-cli dave@example.test | jq -r .access_token)" | jq .email_verified   # false
token backlog-web alice@example.test | jq .error                                                  # "unauthorized_client"

docker rm -f kc-realm-test
```
