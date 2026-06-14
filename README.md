# WebTransport Multiplayer Asteroids

Real-time multiplayer space shooter demonstrating WebTransport's core split: unreliable QUIC datagrams for position updates, reliable ordered streams for game events.

## Why WebTransport

The game has two fundamentally different data types handled by the same connection:

| Data | Channel | Why |
|---|---|---|
| Position updates | Unreliable datagram | Stale position is worthless — skip it, render the next one |
| Player died | Reliable stream | Must arrive exactly once |
| Score changed | Reliable stream | Must arrive in order |
| Player joined/left | Reliable stream | Presence must be consistent |

WebSockets can't do this — everything is reliable TCP. With WebSockets and 200ms of jitter, every position update behind the delayed packet queues up and ships teleport. With WebTransport datagrams, each update is independent. A lost packet is skipped, the next one renders. Movement stays smooth.

## Setup

**Requirements:** Node.js 18+, Chrome or Edge (no Safari support for WebTransport)

```bash
npm install
node server.js
```

Open `http://localhost:3000` in two Chrome tabs.

> The server auto-generates a short-lived TLS certificate on startup and serves its hash at `/cert-hash`. The client fetches this hash and passes it to the `WebTransport` constructor via `serverCertificateHashes` — Chrome's mechanism for trusting self-signed certs without a CA, valid only when the cert is ≤14 days old.

## How to Play

| Key | Action |
|---|---|
| `↑` | Thrust |
| `←` `→` | Rotate |

Ram into other ships to score. **Faster ship wins** — the ship with higher speed at the moment of collision survives and scores; the slower ship dies and respawns after 3 seconds.

## Architecture

```
server.js          WebTransport server + game loop + collision detection
game/
  state.js         Player state, spawn/respawn logic
  physics.js       Server-side collision detection
  encode.js        Binary datagram encoding/decoding
public/
  client.js        WebTransport client, physics prediction, canvas rendering
  index.html       Canvas + HUD
  style.css        Dark theme
```

### Message Format

**Position datagram — 10 bytes, client → server, ~60Hz**
```
[x: uint16][y: uint16][angle: uint16][vx: int16][vy: int16]
```
Binary encoding keeps datagrams small for 20Hz broadcast to all clients. JSON at this rate would be 3–4× larger.

**Snapshot datagram — 1 + N×11 bytes, server → client, 20Hz**
```
[count: uint8][id: uint8][x: uint16][y: uint16][angle: uint16][vx: int16][vy: int16] × N
```

**Game events — newline-delimited JSON over reliable bidirectional stream**
```json
{ "type": "welcome",      "playerId": 1, "color": "#f97316", "x": 400, "y": 300 }
{ "type": "player_joined","playerId": 2, "color": "#3b82f6", "x": 200, "y": 150, "score": 0 }
{ "type": "player_died",  "playerId": 2, "killedBy": 1 }
{ "type": "score",        "playerId": 1, "score": 3 }
{ "type": "respawn",      "playerId": 2, "x": 600, "y": 400 }
{ "type": "player_left",  "playerId": 2 }
```

### Ship Physics

Asteroids-style inertia — the server and client both run the same physics so the client can predict its own position between 20Hz snapshots:

```js
const THRUST        = 0.2    // px/frame² while Up held
const ROTATION_RATE = 0.05   // radians/tick while Left/Right held
const FRICTION      = 0.98   // velocity multiplier per tick
const MAX_SPEED     = 8      // px/frame cap
```

Clients run physics locally for their own ship (client-side prediction) and dead-reckon other ships between snapshots using received `vx`/`vy`.

## Tech Stack

- **Server:** Node.js + [`@fails-components/webtransport`](https://github.com/fails-components/webtransport) (HTTP/3 + QUIC via quiche/BoringSSL)
- **TLS:** [`@peculiar/x509`](https://github.com/PeculiarVentures/x509) — generates an ECDSA P-256 cert on startup; hash served at `/cert-hash` for `serverCertificateHashes`
- **Client:** Vanilla JS + HTML5 Canvas, no framework
