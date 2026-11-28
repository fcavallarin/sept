# SEPT protocol overview

> **Status:** implementation-oriented, pre-1.0 documentation. This is not yet a normative RFC and wire compatibility is not guaranteed across unreleased revisions.

SEPT is built around **typed encrypted events between device identities**. Devices keep private keys locally, learn other devices' public keys through bootstrap/pairing and signed system events, and evaluate authorization from local directed policies.

## Identities

Each device has two key pairs:

- **Ed25519** signing key pair;
- **X25519** encryption/key-agreement key pair.

Device IDs are derived from signing public-key material in the current implementation. Network and event IDs use deterministic/hash-based helpers where applicable.

Private keys remain in client-side storage. The relay stores signing public keys required to authenticate requests and verify relay-facing event signatures.

## Canonical serialization

SEPT uses canonical JSON when data must have a stable serialized representation for encryption/signing/ID derivation.

The common event serialization helper is conceptually:

```js
canonicalJson({
  networkId,
  eventId,
  recipients,
  senderDeviceId,
  body,
  ts,
})
```

For event-ID derivation, the current sender serializes the same structure with an empty `eventId` field, derives the `evt_*` identifier from that canonical wire material, and then includes the resulting identifier in the signed serialization.

Binary values transported in JSON are base64url encoded.

## Application event payload

An application event starts as:

```js
{
  type: "message.send",
  payload: {
    text: "hello"
  }
}
```

`type` is the authorization/dispatch vocabulary. `payload` belongs to the application.

System events use the reserved `sept.*` namespace.

## Sending an event

For each outgoing event the client currently performs the following steps.

### 1. Resolve and authorize recipients

The client loads recipient device public keys from local storage and checks the directed policy:

```text
(senderDeviceId, recipientDeviceId, eventType)
```

Admins currently bypass ordinary application policy checks.

### 2. Create a fresh payload key

A random 32-byte symmetric payload key is generated for the event.

### 3. Encrypt `{type, payload}`

The canonical JSON representation of the application event is encrypted with **XChaCha20-Poly1305** using the payload key and a random 24-byte nonce.

Wire representation is a base64url string containing nonce + authenticated ciphertext.

### 4. Wrap the payload key per recipient

For each recipient:

1. sender X25519 private key + recipient X25519 public key derive a shared secret;
2. HKDF-SHA256 derives a wrap key using the per-wrap nonce as salt and the current domain-separation info string;
3. XChaCha20-Poly1305 encrypts the payload key;
4. nonce + ciphertext are base64url encoded as `encryptedPayloadKey`.

This allows one encrypted payload to be addressed to multiple recipients while each recipient receives its own wrapped payload key.

### 5. Derive and sign the event ID and event material

After encrypting the payload and wrapping the payload key for all recipients, the sender derives `eventId` from canonical serialized wire material containing:

- network ID;
- the full recipient list, including each wrapped payload key;
- sender device ID;
- encrypted payload;
- timestamp.

The `eventId` slot itself is empty during this derivation, avoiding a circular dependency.

The sender then creates two Ed25519 signatures that both include the resulting `eventId`:

- an end-recipient signature over serialized event material with an empty recipient list;
- a relay-facing signature over serialized event material including the full recipient list.

The relay-facing signature lets the relay reject a request whose event ID, recipient list, encrypted payload or timestamp was not signed by the authenticated sender.

The recipient signature lets a recipient verify sender authenticity and cryptographically bind the received `eventId` to the ciphertext and timestamp independently of relay-side recipient routing.

### 6. Store locally and submit

The sender stores an outgoing event locally, then sends the encrypted representation to the relay.

The current request body includes fields conceptually equivalent to:

```js
{
  eventId,
  senderDeviceId,
  encryptedPayload,
  recipients: [
    { deviceId, encryptedPayloadKey }
  ],
  timestamp,
  signature,
  relaySignature,
}
```

The application `type` is not sent as a top-level relay field; it is available only after decrypting `{type,payload}` on a recipient device. The relay still observes routing and transport metadata such as sender/recipient IDs, timestamps, ciphertext sizes and the event identifier. See [Security](security.md).

### 7. Resend until accepted

The sender keeps the encrypted payload of an outgoing event until the relay accepts it (returns a sequence). If the request fails temporarily (relay unreachable, 5xx, 408/429, or a clock-related refusal), the client rebuilds the same request from local state and resends it on the next synchronization: same `eventId`, `timestamp`, ciphertext and wrapped keys, and identical signatures (Ed25519 signatures are deterministic). A permanent refusal (any other 4xx) marks the event as failed and stops the resends. Outgoing events are posted one at a time, in send order; a resend pass stops when the relay looks unreachable, but skips an event the relay fails on by itself (500), which stays queued, so it cannot block the events after it.

## Relay processing

For established devices, relay HTTP requests are signed by the device and authenticated against the device signing public key stored in D1.

When receiving an event, the relay:

1. authenticates the request/device;
2. checks that the authenticated device matches `senderDeviceId`;
3. verifies the relay-facing event signature;
4. if it already stores an event with this `eventId` from the same sender and network, returns that event's sequence and stops: a resend after a lost response is neither stored nor delivered twice (an ID held by another sender or network is refused with 409);
5. increments a network-wide/current server event sequence counter;
6. stores the encrypted event;
7. creates one pending row for each valid, non-revoked recipient belonging to the same network;
8. pushes the recipient-specific event through the network Durable Object if the recipient is connected;
9. invokes the server-side `event.received` plugin hook.

The relay does not need the plaintext application payload to route the event.

The deduplication in step 4 lasts as long as the relay keeps the event, that is until every recipient has ACKed it. A resend after that is stored and delivered again; recipients then discard it as a duplicate by `eventId`.

## Receiving an event

The recipient receives an object containing the shared encrypted payload plus its recipient-specific encrypted payload key.

The client then:

1. resolves the sender from local trusted device state;
2. verifies the Ed25519 sender signature;
3. unwraps the payload key using recipient private X25519 key + sender public X25519 key;
4. decrypts and parses `{type,payload}`;
5. evaluates the sender-to-recipient local policy for `type`;
6. persists the event locally;
7. ACKs the event to the relay;
8. routes SEPT system events or invokes a registered application handler.

ACK means that the relay no longer needs to deliver the event to this recipient. For accepted events, local persistence occurs before ACK. ACK does not imply successful handler execution.

A failing application handler does not stop local processing. The client records the failure on the stored event (`processedAt`, `handlerResult` holding the error string, `handlerFailed`), emits the local `handler.failure` event and continues with the next event, so one malformed application event cannot hold back the rest of a batch. The failed event is not retried. System events behave differently; see [System event namespace](#system-event-namespace).

A policy-denied application event is discarded and ACKed without being persisted or delivered to the application handler.

## Synchronization and delivery

SEPT supports two receive paths that converge on the same event-processing pipeline:

- **WebSocket push** after `connect()`;
- **pull synchronization** through `sync()` / polling.

The relay stores pending delivery state per `(recipient,event)` until ACK.

ACK removes the recipient's pending row. When no pending rows remain for an event, the current server implementation can delete the shared encrypted event row.

## Ordering

The relay assigns a monotonically increasing `sequence` value when accepting an event. Pending events are returned ordered by sequence.

Sequence is relay-managed transport ordering; it is not currently an end-to-end signed field. Applications should not interpret it as a cryptographically trusted statement from the sender.

## Event IDs

The current sender derives an `evt_*` ID from canonical serialized wire material after payload encryption and per-recipient payload-key wrapping. The derivation uses the event serialization with an empty `eventId` slot, then hashes that representation through the current `makeIdFromStr("evt", ...)` helper.

The resulting `eventId` is included in both sender signatures. A relay therefore cannot replace the identifier on an accepted/delivered event without causing signature verification to fail. Recipients use the authenticated `eventId` for persistence, deduplication and ACK bookkeeping.

The reference recipient does **not** independently recompute the deterministic ID because it receives only its recipient-specific wrapped payload key rather than the sender's full recipient list. The reference server also verifies the sender's relay signature but does not currently recompute the `eventId` derivation. Therefore the ID is cryptographically authenticated as sender-chosen event identity, while deterministic derivation is currently an implementation convention rather than an independently enforced protocol invariant.

## System event namespace

Current SEPT system event types include:

```text
sept.policy.update
sept.admin.grant
sept.admin.revoke
sept.device.add
sept.device.invalidate
```

These are handled internally rather than through application `register()`
handlers. After updating local state, the client emits the corresponding local
client event documented in the [Client API](api/classes/SeptClient.html#on).

A received system event is applied only when the sender is locally recognized as an admin; one from a non-admin sender is marked as processed and ignored. System events are treated as non-skippable during local processing: if a system event cannot be applied, local protocol state no longer matches the network's, so the client enters a persistent system failure instead of retrying (without transactional handlers, a failed handler may have partially applied its changes; see [security.md](security.md)). The failing event stays locally unprocessed, with the error recorded in `handlerResult` and `handlerFailed` set, and the client:

- stores the failure, so it survives restarts and is returned by `getSystemFailure()`;
- stops polling and closes the WebSocket;
- emits the local `system.failure` client event, and again on every later `connect()`;
- stops downloading, persisting, ACKing and processing events: the events after the failing one stay pending on the relay;
- refuses to `send()`.

The failing event itself has already been ACKed, since it was successfully received and persisted. Recovery requires resetting and re-pairing the device; applications should tell the user to contact an admin.

## Pairing

### Device initialization

A joining device runs `initDevice()` to create signing/encryption key pairs and derives its device ID.

The joining device's public data is supplied to an existing admin through the application/out-of-band UX.

### Admin creates pairing

The admin creates a short-lived PIN and asks the relay to store a pairing record containing:

- device/network identifiers;
- joining-device signing public key;
- initiator admin device ID;
- admin X25519 public key;
- an encrypted payload for the joining device;
- a separate encrypted admin payload for pairing completion.

The joining-device payload contains network identity, current admin public keys and optional application metadata. The relay stores it as an opaque encrypted blob.

The admin completion payload is encrypted so the relay does not need to see admin-side application metadata.

### New device redeems PIN

The new device presents `(deviceId, pin)` to the relay. The relay marks the pairing redeemed, registers the device for transport, and returns the encrypted joining-device payload.

An incorrect PIN deletes the pending pairing. A successful redemption is single-use: subsequent redemption attempts for the same device ID are rejected. 
The redeemed record remains available only for the initiating admin to complete the pairing flow.

The new device decrypts it and installs the network plus current admin public keys as its initial trust state.

### Initiating admin completes

The initiating admin polls redeemed pairings. The server only returns completion records initiated by that authenticated admin. After decrypting the admin payload, the initiator stores the new device, deletes the pairing record, and notifies other admins through `sept.device.add`.

## Request authentication

After a device is registered, REST requests are authenticated with SEPT request headers/signatures generated by the client and verified against the device signing public key in D1.

This relay authentication is distinct from application-event authorization. The relay decides whether a request comes from a registered transport identity; the recipient client decides whether the sender is permitted to perform a specific application event.

## Protocol vs application behavior

SEPT does not define application semantics such as chat conversations, device commands, agent tools, media sessions, tunnels or user-interface behavior.

Applications define their own typed events and may use SEPT for authenticated, authorized and durable coordination. Those application event vocabularies are intentionally outside the SEPT wire protocol.
