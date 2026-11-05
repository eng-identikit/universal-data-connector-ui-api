# Universal Data Connector UI API

🇬🇧 [English version](./README.md)

Backend for frontend (BFF) della [UI di Universal Data Connector](../universal-data-connector-ui/README.it.md). La UI è un **orchestratore** di istanze UDC: questo servizio ne tiene il catalogo, disegna ognuna come un flusso (sorgenti → UDC → destinazioni) e ne modifica la configurazione per conto dell'utente.

- **Catalogo** delle istanze UDC in PostgreSQL, ognuna con il suo URL e una **chiave di servizio** (cifrata a riposo).
- **Flusso** di un'istanza in una sola chiamata: connettori (sorgenti), subscription su HTTP/MQTT/NATS/WebSocket con il loro transformer, endpoint MCP (destinazioni), libreria dei transformer, tenant e posizione di ogni blocco sulla lavagna.
- **Blocchi**: aggiunta, modifica e rimozione di sorgenti e destinazioni, con la loro posizione.
- **Proxy** verso l'API di ogni istanza (`/udc/:id/proxy/...`) e verso il suo stream in tempo reale, con la chiave di servizio, filtrato per ruolo.
- **Login**: utenti locali, oppure Keycloak quando `KEYCLOAK_URL` è impostato (bearer-only, come in iotagent-ui-bff).

L'alberatura segue [iotagent-ui-bff](https://github.com/Engineering-Research-and-Development/iotagent-ui/tree/main/iotagent-ui-bff).

## Avvio

Con lo stack UDC (`docker compose up -d --build` nel repo `universal-data-connector`) il servizio parte sulla porta **9000** e registra l'UDC dello stesso stack. In locale:

```bash
cp .env.example .env    # database, segreti, password dell'admin
npm install
npm run dev             # http://localhost:9000/api/v1
```

Al primo avvio crea il database (`UI_DB_NAME`) se manca, applica le migrazioni, crea l'utente admin (login locale; la password viene da `UI_ADMIN_PASSWORD` oppure è generata e scritta nel log una volta) e registra l'UDC in `UDC_DEFAULT_URL` con `UDC_DEFAULT_KEY`.

## Ruoli

| Ruolo | Può |
|---|---|
| viewer | Vedere la lavagna e ogni flusso; i segreti nelle configurazioni sono mascherati |
| operator | viewer + aggiungere, modificare e rimuovere sorgenti e destinazioni, spostare i blocchi |
| admin | operator + registrare e rimuovere istanze UDC, gestire gli utenti della UI e, tramite il proxy, tenant, utenti e chiavi delle istanze |

Con Keycloak il ruolo viene dai ruoli di realm `udc-admin` / `udc-operator` (`KEYCLOAK_ADMIN_ROLE`, `KEYCLOAK_OPERATOR_ROLE`); `KEYCLOAK_AUTHORIZED_ROLE`, se impostato, serve per usare la UI.

## Collegare un UDC

Il servizio parla con ogni istanza tramite una **chiave di servizio**: una API key non legata a un tenant che agisce come un superadmin. Per registrare un'istanza serve:
- `apiKey`: una chiave di servizio creata sull'UDC (`POST /api/v1/service-keys` da superadmin, oppure `BROKER_SERVICE_KEY` nel suo ambiente);
- oppure `username` + `password` di un superadmin dell'UDC: usati una volta per creare la chiave di servizio, mai salvati.

La chiave viene verificata prima di salvare l'istanza (`force: true` la salva comunque). `PATCH /auth/udc/:id` la sostituisce allo stesso modo: una nuova `apiKey`, oppure `username` + `password` per crearne una.

## API (`/api/v1`)

| | Endpoint |
|---|---|
| Pubbliche | `GET /basic/config` (login locale o Keycloak), `GET /basic/health`, `POST /basic/login`, `POST /basic/refresh` |
| Profilo | `GET /auth/me`, `POST /auth/me/password` (restituisce una nuova coppia di token) |
| Utenti (admin, login locale) | `GET`/`POST /auth/users`, `PATCH`/`DELETE /auth/users/:id` |
| Catalogo | `GET /auth/udc` (con stato in tempo reale), `POST /auth/udc` (admin), `GET /auth/udc/:id`, `PATCH /auth/udc/:id` (posizione: operator; il resto: admin), `DELETE /auth/udc/:id` (admin) |
| Flusso | `GET /auth/udc/:id/flow`, `PUT /auth/udc/:id/layout` (`{ "<nodeKey>": { x, y } \| null }`) |
| Sorgenti | `POST /auth/udc/:id/sources` (`{ source, position? }`), `PUT`/`DELETE /auth/udc/:id/sources/:sourceId` |
| Destinazioni | `POST /auth/udc/:id/sinks` (`{ tenant, subscription, position? }`), `PATCH`/`DELETE /auth/udc/:id/sinks/:tenant/:subscriptionId` |
| Proxy | `ALL /auth/udc/:id/proxy/<path>` → `<udc>/api/v1/<path>`; `X-Tenant` viene inoltrato |
| Stream in tempo reale | WebSocket `/auth/udc/:id/stream?access_token=<token della UI>&tenant=<id>` → `/api/v1/stream` dell'istanza con la chiave di servizio |

Errori: `{ "error": { "message", "details"? } }`. Chiavi dei nodi nel layout: `source:<id>`, `sink:subscription:<tenant>:<id>`, `sink:mcp`.

Regole del proxy: i viewer possono solo leggere (segreti mascherati); le modifiche richiedono un operator; utenti, chiavi di servizio, sessioni, storico accessi, API key, membri e modifiche dei tenant richiedono un admin; gli endpoint `/auth/*` dell'istanza non passano mai dal proxy.

## Configurazione

| Variabile | Predefinito | |
|---|---|---|
| `PORT` | 9000 | |
| `UI_DB_URL` oppure `UI_DB_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD` | `localhost:5432/udc_ui`, utente `udc` | PostgreSQL; il database viene creato se manca (`UI_DB_MAINTENANCE`, predefinito `postgres`) |
| `UI_JWT_SECRET` | casuale | Firma i token della UI: impostalo, altrimenti le sessioni finiscono a ogni riavvio |
| `UI_ACCESS_TOKEN_TTL` / `UI_REFRESH_TOKEN_TTL` | `1h` / `7d` | |
| `UI_ENCRYPTION_KEY` | — | **Obbligatoria**: cifra le chiavi di servizio nel catalogo |
| `UI_ADMIN_USER` / `UI_ADMIN_PASSWORD` | `admin` / generata | Primo admin (login locale) |
| `UDC_DEFAULT_NAME` / `UDC_DEFAULT_URL` / `UDC_DEFAULT_PUBLIC_URL` / `UDC_DEFAULT_KEY` | — | UDC registrato al primo avvio |
| `UDC_TIMEOUT_MS` | 10000 | Timeout delle chiamate alle istanze |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT`, `KEYCLOAK_UI_CLIENT`, `KEYCLOAK_AUTHORIZED_ROLE`, `KEYCLOAK_ADMIN_ROLE`, `KEYCLOAK_OPERATOR_ROLE` | — | Login con Keycloak |

## Struttura

```
index.js                   app Express, avvio (database, migrazioni, seed)
config/index.js            configurazione dall'ambiente
auth/index.js              login locale (passport) e token
db/                        pool PostgreSQL, migrazioni
middlewares/               keycloak, extractToken, checkRole, requireRole
models/                    User, Udc (catalogo), Layout (posizioni dei blocchi)
routes/basic_routes/       pubbliche: config, health, login, refresh
routes/secure_routes/      autenticate: profilo, utenti, catalogo UDC, flusso, blocchi, proxy
services/                  udcClient (chiamate con la chiave di servizio), flow, streamProxy, secrets (cifratura, mascheramento)
seed.js                    primo admin e UDC predefinito
tests/test-api.js          test d'integrazione contro un UDC reale
```

## Test

```bash
UDC_TEST_URL=http://localhost:3000 UDC_TEST_ADMIN_PASSWORD=<password dell'admin UDC> npm test
```

Gira contro un UDC reale (lo stack Compose) in un database usa e getta, e rimuove ciò che ha creato.
