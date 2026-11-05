# Universal Data Connector UI API

🇮🇹 [Versione italiana](./README.it.md)

Backend for frontend (BFF) of the [Universal Data Connector UI](../universal-data-connector-ui/README.md). The UI is an **orchestrator** of UDC instances: this service keeps their catalog, draws each one as a flow (sources → UDC → sinks) and changes their configuration on the user's behalf.

- **Catalog** of UDC instances in PostgreSQL, each with its URL and a **service key** (encrypted at rest).
- **Flow** of an instance in one call: connectors (sources), subscriptions over HTTP/MQTT/NATS/WebSocket with their transformer, the MCP endpoint (sinks), the transformer library, the tenants and the position of every block on the board.
- **Blocks**: add, change and remove sources and sinks; their position is saved with them.
- **Proxy** to each instance's API (`/udc/:id/proxy/...`) and to its realtime stream, with the service key, filtered by role.
- **Login**: local users, or Keycloak when `KEYCLOAK_URL` is set (bearer-only, as in iotagent-ui-bff).

Its structure follows [iotagent-ui-bff](https://github.com/Engineering-Research-and-Development/iotagent-ui/tree/main/iotagent-ui-bff).

## Running

With the UDC stack (`docker compose up -d --build` in the `universal-data-connector` repo) the service starts on port **9000** and registers the UDC of the same stack. Locally:

```bash
cp .env.example .env    # database, secrets, admin password
npm install
npm run dev             # http://localhost:9000/api/v1
```

On the first start it creates the database (`UI_DB_NAME`) if missing, applies its migrations, creates the admin user (local login; the password comes from `UI_ADMIN_PASSWORD` or is generated and logged once) and registers the UDC in `UDC_DEFAULT_URL` with `UDC_DEFAULT_KEY`.

## Roles

| Role | Can |
|---|---|
| viewer | See the board and every flow; secrets in configurations are masked |
| operator | viewer + add, change and remove sources and sinks, move blocks |
| admin | operator + register and remove UDC instances, manage the UI users and, through the proxy, the instances' tenants, users and keys |

With Keycloak the role comes from the realm roles `udc-admin` / `udc-operator` (`KEYCLOAK_ADMIN_ROLE`, `KEYCLOAK_OPERATOR_ROLE`); `KEYCLOAK_AUTHORIZED_ROLE`, when set, is required to use the UI at all.

## Connecting a UDC

The service talks to each instance with a **service key**: an API key that is not bound to a tenant and acts as a superadmin. Registering an instance takes either:
- `apiKey`: a service key created on the UDC (`POST /api/v1/service-keys` as a superadmin, or `BROKER_SERVICE_KEY` in its environment);
- `username` + `password` of a UDC superadmin: used once to create a service key, never stored.

The key is checked before the instance is saved (`force: true` saves it anyway). `PATCH /auth/udc/:id` replaces it the same way: a new `apiKey`, or `username` + `password` to mint one.

## API (`/api/v1`)

| | Endpoint |
|---|---|
| Public | `GET /basic/config` (local or Keycloak login), `GET /basic/health`, `POST /basic/login`, `POST /basic/refresh` |
| Profile | `GET /auth/me`, `POST /auth/me/password` (returns a new token pair) |
| Users (admin, local login) | `GET`/`POST /auth/users`, `PATCH`/`DELETE /auth/users/:id` |
| Catalog | `GET /auth/udc` (with live status), `POST /auth/udc` (admin), `GET /auth/udc/:id`, `PATCH /auth/udc/:id` (position: operator; the rest: admin), `DELETE /auth/udc/:id` (admin) |
| Flow | `GET /auth/udc/:id/flow`, `PUT /auth/udc/:id/layout` (`{ "<nodeKey>": { x, y } \| null }`) |
| Sources | `POST /auth/udc/:id/sources` (`{ source, position? }`), `PUT`/`DELETE /auth/udc/:id/sources/:sourceId` |
| Sinks | `POST /auth/udc/:id/sinks` (`{ tenant, subscription, position? }`), `PATCH`/`DELETE /auth/udc/:id/sinks/:tenant/:subscriptionId` |
| Proxy | `ALL /auth/udc/:id/proxy/<path>` → `<udc>/api/v1/<path>`; `X-Tenant` is passed through |
| Realtime stream | WebSocket `/auth/udc/:id/stream?access_token=<UI token>&tenant=<id>` → the instance's `/api/v1/stream` with the service key |

Errors: `{ "error": { "message", "details"? } }`. Node keys of the layout: `source:<id>`, `sink:subscription:<tenant>:<id>`, `sink:mcp`.

Proxy rules: viewers only read (secrets masked); changes need an operator; users, service keys, sessions, access log, API keys, tenant members and tenant changes need an admin; the instance's `/auth/*` endpoints are never proxied.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | 9000 | |
| `UI_DB_URL` or `UI_DB_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD` | `localhost:5432/udc_ui`, user `udc` | PostgreSQL; the database is created when missing (`UI_DB_MAINTENANCE`, default `postgres`) |
| `UI_JWT_SECRET` | random | Signs the UI's tokens: set it, or sessions end at every restart |
| `UI_ACCESS_TOKEN_TTL` / `UI_REFRESH_TOKEN_TTL` | `1h` / `7d` | |
| `UI_ENCRYPTION_KEY` | — | **Required**: encrypts the service keys in the catalog |
| `UI_ADMIN_USER` / `UI_ADMIN_PASSWORD` | `admin` / generated | First admin (local login) |
| `UDC_DEFAULT_NAME` / `UDC_DEFAULT_URL` / `UDC_DEFAULT_PUBLIC_URL` / `UDC_DEFAULT_KEY` | — | UDC registered on the first start |
| `UDC_TIMEOUT_MS` | 10000 | Timeout of calls to the instances |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT`, `KEYCLOAK_UI_CLIENT`, `KEYCLOAK_AUTHORIZED_ROLE`, `KEYCLOAK_ADMIN_ROLE`, `KEYCLOAK_OPERATOR_ROLE` | — | Keycloak login |

## Structure

```
index.js                   Express app, startup (database, migrations, seed)
config/index.js            configuration from the environment
auth/index.js              local login (passport) and tokens
db/                        PostgreSQL pool, migrations
middlewares/               keycloak, extractToken, checkRole, requireRole
models/                    User, Udc (catalog), Layout (block positions)
routes/basic_routes/       public: config, health, login, refresh
routes/secure_routes/      authenticated: profile, users, UDC catalog, flow, blocks, proxy
services/                  udcClient (calls with the service key), flow, streamProxy, secrets (encryption, masking)
seed.js                    first admin and default UDC
tests/test-api.js          integration test against a real UDC
```

## Tests

```bash
UDC_TEST_URL=http://localhost:3000 UDC_TEST_ADMIN_PASSWORD=<UDC admin password> npm test
```

It runs against a real UDC (the Compose stack) in a throw-away database, and removes what it created.
