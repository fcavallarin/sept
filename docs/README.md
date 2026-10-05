# SEPT documentation

This directory documents the current implementation and intended architecture of SEPT.

SEPT is still pre-1.0. Unless a document explicitly says otherwise, these files describe the **current implementation**, not a frozen wire-protocol specification.

## Start here

1. [JavaScript quick start](sept-quickstart.md) — use `@sept-protocol/client` directly.
2. [Architecture](architecture.md) — understand component and trust boundaries.
3. [Protocol](protocol.md) — event, pairing and synchronization flow.
4. [Authorization](authorization.md) — local default-deny policies and admin events.
5. [Security](security.md) — guarantees, metadata exposure, trust assumptions and known gaps.
6. [Self-hosting](self-hosting.md) — deploy a standalone Cloudflare relay.
7. [Client API](api/index.html) — public `SeptClient` surface.
8. [Event filtering](event-filtering.md) — query locally stored events by fields and relations.

## Scope

SEPT defines device identity, pairing, encrypted typed events, signed protocol events, local authorization state, persistence and relay synchronization.

Application behavior belongs above SEPT. Applications are free to define event types for messaging, device control, agent tools, workflow coordination or other domain-specific actions without changing the SEPT wire protocol.

## Documentation policy

When implementation and documentation disagree, treat the code as authoritative until the discrepancy is fixed. Security-relevant discrepancies should be documented explicitly rather than papered over.
