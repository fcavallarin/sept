# Self-hosting the SEPT relay

SEPT includes a generic Cloudflare deployment template for self-hosting `@sept/server`.

The scaffold command creates a **standalone project in a directory chosen by you**. The generated server is not a workspace inside the SEPT repository and consumes `@sept/server` as a normal npm dependency.

## Requirements

- Node.js/npm
- a Cloudflare account
- Wrangler access to that account

Wrangler is included as a development dependency in the generated project.

## Quick start

From the SEPT repository root:

```bash
npm run scaffold:server -- my-sept ../my-sept-server
cd ../my-sept-server
npm install
```

The arguments are:

```text
npm run scaffold:server -- <name> <targetDir>
```

The scaffold command:

1. copies `server/templates/cloudflare` to `targetDir`;
2. replaces `{{ name }}` in the generated `package.json` and `wrangler.jsonc`;
3. leaves the generated project independent from the SEPT repository.

The generated deployment contains:

```text
my-sept-server/
├── migrations/
│   └── 0001_initial.sql
├── src/
│   └── index.js
├── package.json
└── wrangler.jsonc
```

Its `package.json` depends on `@sept/server`, so the generated project can be moved, versioned and deployed independently.

### Create and deploy the server

Run from the generated directory:

```bash
wrangler d1 create --binding DB --update-config my-sept
wrangler r2 bucket create --binding STORAGE --update-config my-sept
wrangler d1 migrations apply my-sept --remote
wrangler deploy
```

Wrangler prints the deployed Worker URL, typically of the form:

```text
https://<worker>.<account-subdomain>.workers.dev
```

## Cloudflare resources

The generic scaffold currently expects:

| Binding | Resource | Purpose |
| --- | --- | --- |
| `DB` | D1 | networks, devices, pairings, encrypted events and pending delivery |
| `RELAY` | Durable Object | live WebSocket delivery per SEPT network |
| `STORAGE` | R2 | configured server bucket; storage usage is evolving |

The Worker enables the `nodejs_compat` compatibility flag and exports `DORelay` from `@sept/server`.

### Durable Object configuration

The generated `wrangler.jsonc` binds:

```jsonc
"durable_objects": {
  "bindings": [
    {
      "name": "RELAY",
      "class_name": "DORelay"
    }
  ]
}
```

and contains the initial SQLite Durable Object migration. Wrangler applies the DO class migration as part of deployment; you do not create a separate named Durable Object instance manually. Instances are derived by the server from the SEPT network ID.

## Subsequent deployments

After the resources have been created, deploy code changes with:

```bash
npm run deploy
```

If a new D1 migration is added to the generated deployment, apply remote migrations with:

```bash
npm run migrate
```

Then deploy as usual.

## Local development

Apply migrations to the local Wrangler D1 database:

```bash
npm run migrate:local
```

Then start the Worker locally:

```bash
npm run dev
```

The default local Wrangler origin is normally:

```text
http://localhost:8787
```

## Point clients at your relay

Configure `SeptClient.create()` with the deployed origin:

```js
const sept = await SeptClient.create({
  restEndpoint: "https://<your-worker>.workers.dev",
  dataStore: {
    // platform-specific datastore configuration
  },
})
```

`connect()` derives `wss://` from the same endpoint and connects to `/ws` after obtaining a relay ticket.

## Generic server composition

The generated server starts with a minimal SEPT composition:

```js
import { createSeptServer } from "@sept/server"

export { DORelay } from "@sept/server"

export default createSeptServer([], {
  maxNetworks: 1
})
```

Application-specific integrations can be added through the server plugin interface without becoming part of the SEPT protocol.

### Network bootstrap limit

`createSeptServer()` accepts a `maxNetworks` option controlling how many SEPT networks may be bootstrapped on that server:

```js
export default createSeptServer(plugins, {
  maxNetworks: 1
})
```

The generated template uses `1`, which is appropriate for a typical single-network self-hosted deployment.

Once the configured number of networks exists, further `POST /bootstrap` requests are rejected. Shared or public relay operators can explicitly configure a higher value based on the intended deployment and available resources.

Because bootstrap is intentionally unauthenticated, `maxNetworks` also acts as a basic resource-exhaustion safeguard. Public permissionless deployments may still want additional admission controls.

## Current relay routes

The core `@sept/server` currently provides:

```text
POST   /bootstrap
POST   /event
GET    /events
PATCH  /events
POST   /devices/create-pairing
GET    /devices/pairing/:id/:pin
GET    /paired-device/:deviceId
DELETE /paired-device/:deviceId
PATCH  /devices/set-admin
POST   /devices/invalidate
GET    /get-relay-ticket
GET    /ws
```

Except for initial bootstrap/pairing phases as required by the protocol flow, established-device operations use SEPT signed-request authentication.

## Worker plugins

`createSeptServer()` accepts plugins that can add HTTP routes and install server hooks.

Conceptually:

```js
export default createSeptServer([
  {
    routes: [
      { method: "POST", path: "/my-route", handler },
    ],
    hooks: {
      "event.received": async ({ env, eventData }) => {
        // application-specific integration
      },
    },
  },
], options)
```

Plugins are deployment concerns, not requirements for a generic SEPT relay. The scaffolded server starts without application-specific plugins.

### Custom route handlers

A plugin route handler uses the following signature:

```js
async function handler(request, env, params, context) {
  // ...
  return jsonResponse({ ok: true })
}
```

The arguments are:

- `request`: the standard Worker `Request`;
- `env`: the Cloudflare Worker environment, containing configured bindings and variables such as `DB`, `RELAY` and application-specific bindings;
- `params`: an object containing decoded path parameters;
- `context`: the SEPT server context containing `workerCtx`, `eventBus` and the options passed to `createSeptServer()`.

A handler must return a standard `Response`.

The server package exports helpers commonly needed by custom handlers:

```js
import {
  getAuth,
  httpError,
  jsonResponse,
  readJson,
} from "@sept/server"

async function handler(request, env, params) {
  const body = await readJson(request)
  const auth = await getAuth(env, request, body)

  return jsonResponse({
    deviceId: auth.deviceId,
    networkId: auth.networkId,
    params,
  })
}
```

`getAuth()` verifies the signed SEPT request and returns the authenticated device information. When the request has a JSON body, the parsed body must be passed to `getAuth()` as shown above.

### Server hooks

The following server hook is currently available:

#### `event.received`

Called once for each recipient after an event has been stored and forwarded to the recipient's relay connection.

```js
"event.received": async ({ env, eventData }) => {
  // application-specific integration
}
```

`eventData` contains the recipient-specific encrypted event representation:

```js
{
  eventId,
  networkId,
  senderDeviceId,
  deviceId,
  encryptedPayload,
  encryptedPayloadKey,
  sequence,
  signature,
  timestamp,
}
```

`deviceId` is the recipient device ID. The payload and its per-recipient key remain encrypted; server hooks do not receive the decrypted application event type or payload.

## D1 migrations and retained data

The generic scaffold currently starts with:

```text
migrations/0001_initial.sql
```

Its D1 schema includes the core SEPT relay tables:

- `network`
- `device`
- `transport_policy`
- `event`
- `pending_event`
- `device_pairing`
- `counter`
- `seen_nonce`

Encrypted event rows are shared across recipients; each recipient has its own pending row containing the wrapped payload key. ACK removes pending delivery state, and the current server deletes an event once it has no remaining pending recipients.

## Operational security notes

Self-hosting gives you control over infrastructure but does not eliminate the need to understand SEPT's trust model.

Review at least:

- D1 and R2 retention/backups;
- Cloudflare account security;
- Worker logs and observability;
- rate limiting and admission control for bootstrap/pairing routes;
- metadata visibility at the relay;
- privacy implications of any application-specific server plugin;
- migration/rollback procedures.

See [Security](security.md) for protocol-level assumptions and known implementation caveats.
