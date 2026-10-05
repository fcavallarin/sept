# SEPT

**SEPT** is an asynchronous event protocol for devices and services, with end-to-end encryption, distributed ACLs, and offline delivery.

Events are encrypted and authenticated end-to-end. Authorization is evaluated by endpoints rather than delegated to the relay, while the relay handles routing, persistence, and delivery when recipients are offline.

SEPT is designed for event-driven systems where connectivity may be intermittent, including IoT and edge devices, remote services, agents, and distributed applications.

Start here:

- [JavaScript quick start](docs/sept-quickstart.md)
- [Architecture](docs/architecture.md)
- [Protocol overview](docs/protocol.md)
- [Authorization model](docs/authorization.md)
- [Security model and current limitations](docs/security.md)
- [Self-hosting the relay](docs/self-hosting.md)
- [Client API](https://fcavallarin.github.io/sept/api/)
- [Event filtering](docs/event-filtering.md)

> **Project status:** SEPT is under active development and has not received an independent security audit. See [Security](docs/security.md) before using it in a high-risk environment.

## Architecture at a glance

```text
┌──────────────────────┐                         ┌──────────────────────┐
│       Device A       │                         │       Device B       │
│                      │                         │                      │
│      Your app        │                         │      Your app        │
│          │           │                         │          │           │
│      SEPT client     │                         │      SEPT client     │
│   keys + policies    │                         │   keys + policies    │
│   local event store  │                         │   local event store  │
└──────────┬───────────┘                         └──────────┬───────────┘
           │ signed requests                                │ signed requests
           │ encrypted events                               │ encrypted events
           ▼                                                ▼
                    ┌────────────────────────┐
                    │      SEPT relay        │
                    │ Cloudflare Worker/D1   │
                    │ R2 / Durable Object    │
                    │                        │
                    │ routing + offline      │
                    │ storage + delivery     │
                    └────────────────────────┘
```

Private signing and encryption keys stay on devices. Authorization decisions for application events are evaluated from policies stored locally by SEPT clients rather than delegated to the relay.

The relay necessarily observes transport metadata such as device/network identifiers, timing and event sizes. See [Security](docs/security.md) for the current confidentiality boundary and implementation caveats.

## What SEPT is

SEPT provides:

- device identities backed by cryptographic keys;
- explicit pairing and trust bootstrap;
- end-to-end encrypted typed events;
- signed events and signed protocol state changes;
- directed, default-deny device-to-device authorization;
- durable offline delivery;
- REST synchronization and WebSocket push delivery;
- local persistence and event processing through the JavaScript SDK.

SEPT is not a VPN, overlay network, chat protocol, remote-shell protocol, or application-specific messaging format. Applications define their own event types and semantics on top of SEPT.

## Repository layout

```text
client/   @sept-protocol/client  — client runtime, pairing, policies, persistence, sync and WS lifecycle
core/     @sept-protocol/core    — canonical JSON, serialization, IDs, queues, event bus and SQL helpers
crypto/   @sept-protocol/crypto  — signing, hashing and encryption primitives
server/   @sept-protocol/server  — relay routes, request authentication and Durable Object relay
  templates/cloudflare/ — standalone Cloudflare relay template
docs/                    — architecture, protocol, security and API documentation
scripts/                 — development utilities and server scaffolding
```

The repository is an npm workspace so the SEPT packages can be developed and tested together. Applications consuming SEPT are expected to live independently and depend on the published `@sept-protocol/*` packages.

## Install for development

Clone the repository and install the workspace:

```bash
npm install
```

Run the client test suite:

```bash
npm test
```

For application development, install the package you need directly from npm, for example:

```bash
npm install @sept-protocol/client
```

See [JavaScript quick start](docs/sept-quickstart.md) for client setup.

## Create a self-hosted relay

The repository includes a Cloudflare server template. Choose any target directory; the generated project is standalone and depends on `@sept-protocol/server` as a normal npm package.

```bash
npm run scaffold:server -- my-sept ../my-sept-server
cd ../my-sept-server
npm install
```

Then create the Cloudflare resources and deploy:

```bash
wrangler d1 create --binding DB --update-config my-sept
wrangler r2 bucket create --binding STORAGE --update-config my-sept
wrangler d1 migrations apply my-sept --remote
wrangler deploy
```

See [Self-hosting](docs/self-hosting.md) for details.

## Why plain JavaScript?

SEPT is written in plain JavaScript deliberately. Portability is a project requirement, and the same code is intended to run across Node.js, browsers, React Native/Expo, and Cloudflare Workers.

Avoiding a mandatory compile step keeps the implementation easy to inspect and embed. Type declarations describe the public client API without changing the runtime implementation.

## Security

SEPT has **not received an independent security audit**. The current implementation should be treated as pre-1.0 software.

Read [Security](docs/security.md) for the exact trust assumptions, relay-visible metadata, pairing limitations, ordering model, replay behavior and hardening work still required.

## License

See [LICENSE](LICENSE).
