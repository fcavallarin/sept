# SEPT JavaScript quick start

This guide shows direct `@sept-protocol/client` usage in an application.

## Install

Install the client package in your application:

```bash
npm install @sept-protocol/client
```

`@sept-protocol/client` brings in the SEPT core and crypto packages it requires.

`SeptClient` also requires a supported SQLite datastore adapter configuration and a SEPT relay endpoint.

For the Node.js example below, install the SQLite driver:

```bash
npm install better-sqlite3
```

If you are developing SEPT itself from this repository, use `npm install` at the repository root instead.

## Create a client

A client is constructed with `SeptClient.create()`:

```js
import { SeptClient } from "@sept-protocol/client"
import Database from "better-sqlite3"

const sept = await SeptClient.create({
  restEndpoint: "http://localhost:8787",
  dataStore: {
    type: "better-sqlite",
    open: () => new Database("app.db"),
    close: db => db.close(),
  },

  // Application-specific provider used to encrypt secrets
  // Must return the same securely stored 32-byte key across restarts.
  secretKeyProvider: async () => loadSecretKey(),
})
```

`dataStore.type` currently supports the runtimes implemented by the client:

- `better-sqlite`
- `expo-sqlite`

The `open` and `close` functions are supplied by the host application. Use the adapter appropriate for the runtime in which your application runs.

## Create a network

The first device bootstraps a SEPT network and becomes an admin:

```js
const networkId = await sept.bootstrap()
const deviceId = await sept.getDeviceId()

console.log({ networkId, deviceId })
```

`bootstrap()` creates local signing/encryption keys, creates the local network and root device records, and registers the network/root signing public key with the relay.

## Initialize a device that will join

A device that has not joined a network yet first creates its key material:

```js
const deviceData = {
  ...await sept.initDevice(),
  metadata: { name: "Laptop" },
}
```

The returned value can be transported to an admin through your UI, QR code or another out-of-band channel:

```js
{
  deviceId,
  signPublicKey,
  cryptPublicKey,
  metadata: { name: "Laptop" }
}
```

## Pair a new device

On an existing admin device:

```js
const { pin, pairing } = await adminSept.addDevice(
  deviceData,
  {
    deviceMetadata: deviceData.metadata,
    adminMetadata: deviceData.metadata,
  },
  60,
)

console.log("Pairing PIN:", pin)

const { deviceId, metadata } = await pairing
console.log("paired", deviceId, metadata)
```

On the joining device:

```js
const metadata = await joiningSept.pairDevice(pin)
```

The pairing PIN is short-lived. The joining device has no previously trusted admin key at this point, so pairing is the trust-bootstrap phase; read [Security](security.md#pairing-trust-bootstrap) before building a high-risk enrollment flow.

Once pairing completes, the `pairing` promise resolves with `{ deviceId, metadata }`, where `metadata` is the admin-side metadata associated with the paired device. The joining device receives `deviceMetadata` from `pairDevice()`. The `pairing` promise rejects if pairing fails or times out.

## Register an application event

SEPT applications define their own event types:

```js
sept.register("message.send", async ({
  payload,
  senderDeviceId,
  timestamp,
  eventId,
  sequence,
}) => {
  console.log(senderDeviceId, payload.text)
  return { displayed: true }
})
```

Once the handler completes, SEPT stores its return value in `handlerResult`
and sets `processedAt`. If the handler throws or rejects, the stored event has
`handlerFailed` set to true and `handlerResult` contains the error string.

Handlers are serial by default. If an application event may run independently of later events:

```js
sept.registerConcurrent("telemetry.sample", async ({ payload }) => {
  await processSample(payload)
})
```

Concurrent handlers run in the background. Their completion state is still
recorded on the stored event, but their failures are not propagated by
`sync()`.

System event types such as `sept.policy.update` are owned by SEPT and cannot be registered as application handlers.

## Grant permission

A paired non-admin device is not automatically allowed to send every event type to every destination.

An admin grants a directed capability:

```js
await adminSept.grant(
  senderDeviceId,
  recipientDeviceId,
  ["message.send"],
  { reason: "chat permission" }, // Optional metadata
)
```

Check a policy locally:

```js
const allowed = await sept.checkPolicy(
  senderDeviceId,
  recipientDeviceId,
  "message.send",
)
```

See [Authorization](authorization.md) for the model and admin behavior.

## Send an event

```js
await sept.send(
  "message.send",
  { text: "hello" },
  [recipientDeviceId],
)
```

`send()`:

1. resolves recipient public keys from local state;
2. checks the sender-to-recipient policy;
3. encrypts the event payload with a fresh symmetric payload key;
4. wraps that key independently for each recipient;
5. signs the event material;
6. stores the outgoing event locally;
7. posts the encrypted event to the relay.

## Observe client events

In addition to application events, the SDK emits local client events for SEPT
system changes and connection activity. Subscribe to them with `on()`:

```js
sept.on("admin.grant", ({ deviceId }) => {
  console.log("admin granted", deviceId)
})
```

See [Client events](api/classes/SeptClient.html#on) for the complete event list, payloads
and connection notifications.

## Connect and synchronize

### WebSocket connection

```js
await sept.connect()
```

The client opens a WebSocket, synchronizes pending events, and processes pushed events through the same receive pipeline.

Disconnect explicitly when required:

```js
await sept.disconnect()
```

### Polling

For runtimes where a persistent WebSocket is undesirable:

```js
sept.startPolling(10) // seconds
```

Stop it with:

```js
sept.stopPolling()
```

A manual synchronization is also available:

```js
await sept.sync()
```

## Query local state

```js
const myDeviceId = await sept.getDeviceId()
const networkId = await sept.getNetworkId()

const devices = await sept.getDevices()
const admins = await sept.getAdmins()
const graph = await sept.getDeviceGraph()

const isCurrentAdmin = await sept.isCurrentDeviceAdmin()
const isAdmin = await sept.isAdmin(deviceId)

const policy = await sept.getPolicy(srcDeviceId, dstDeviceId)
const allowed = await sept.checkPolicy(srcDeviceId, dstDeviceId, "message.send")

const events = await sept.getStoredEvents()
```

`getStoredEvents(filters)` exposes the current local event-store filtering API. It is an SDK convenience rather than a SEPT wire-protocol feature.

See [Filtering stored events](event-filtering.md) for query examples and supported filters.

## Application storage

Applications using SEPT can reuse its persistent runtime store for small namespaced state:

```js
const prefs = sept.appStorage("my-app")

await prefs.set("theme", "dark")
console.log(await prefs.get("theme"))

await prefs.set("counter", current => (current ?? 0) + 1)
```

Available operations are `get`, `set`, `delete`, `keys` and `all`.

## Admin/device lifecycle

```js
await sept.grantAdmin(deviceId)
await sept.revokeAdmin(deviceId)
await sept.invalidateDevice(deviceId)
```

These operations update local state and distribute signed SEPT system events as appropriate. Device invalidation also updates relay-side transport state.

## Next steps

- [Architecture](architecture.md)
- [Protocol](protocol.md)
- [Authorization](authorization.md)
- [Security](security.md)
- [Client API](api/index.html)
