# Multiplayer Asteroids — WebTransport Project

## What We're Building
A real-time multiplayer space shooter (Asteroids-style) where players control ships on a shared canvas. Position updates fly over unreliable QUIC datagrams for smooth movement, while critical game events (deaths, scores, respawns) travel over reliable ordered streams. This is the canonical WebTransport use case — two data types with opposite delivery requirements, handled by the same connection.

## The Core Experience
- Multiple players join a shared canvas in the browser
- Each player controls a ship: Left/Right arrows rotate, Up arrow thrusts (Asteroids-style inertia)
- All ships move in real time on every connected client
- Collisions are detected server-side
- Deaths and score changes are guaranteed to arrive
- Position updates are fire-and-forget — stale data is dropped, not retransmitted

## The Key Insight (Why WebTransport)
The game has two fundamentally different data types:

| Data | Delivery | Why |
|---|---|---|
| Position updates | Unreliable datagram | Stale position is worthless — skip it, render the next one |
| Player died | Reliable stream | Must arrive exactly once — can't miss a death event |
| Score changed | Reliable stream | Must arrive in order — score integrity matters |
| Player joined/left | Reliable stream | Presence must be consistent across all clients |

This split is impossible with WebSockets (everything is reliable TCP) and impossible with SSE (server → client only). WebTransport is the only browser API that lets you choose per message.

## Why Not WebSockets
If you built this with WebSockets and TCP introduced 200ms of jitter, every position update behind the delayed packet would queue up and arrive in a burst — ships would teleport. With WebTransport datagrams, each position update is independent. A lost packet is skipped, the next one renders. Movement stays smooth regardless of network conditions.

## Tech Stack
- **Server**: Node.js + `@fails-components/webtransport` (handles HTTP/3 + TLS, ships compiled JS)
- **Frontend**: Vanilla JS + HTML5 Canvas
- **TLS**: Self-signed certificate (required even for localhost — this is real WebTransport friction)
- **No framework** — protocol mechanics should be front and center

## Project Structure
```
/
├── server.js                  # WebTransport server + game loop + state
├── certs/
│   ├── certificate.pem        # Self-signed cert (generate with openssl)
│   └── private-key.pem
├── public/
│   ├── index.html             # Canvas + UI
│   ├── client.js              # WebTransport client + game rendering
│   └── style.css
├── game/
│   ├── state.js               # Shared game state (positions, scores, players)
│   └── physics.js             # Collision detection, movement
├── package.json
└── CLAUDE.md
```

## WebTransport Primitives Used
```js
// CLIENT SIDE

// Connect
const transport = new WebTransport('https://localhost:4433/game')
await transport.ready

// Send position (unreliable datagram — fire and forget)
const writer = transport.datagrams.writable.getWriter()
await writer.write(encodePosition({ x, y, angle, velocity }))
writer.releaseLock()

// Receive other players' positions (unreliable)
const reader = transport.datagrams.readable.getReader()
while (true) {
  const { value, done } = await reader.read()
  if (done) break
  renderPosition(decodePosition(value))
}

// Send/receive game events (reliable stream)
const stream = await transport.createBidirectionalStream()
const eventWriter = stream.writable.getWriter()
const eventReader = stream.readable.getReader()

// Listen for death/score events from server
while (true) {
  const { value, done } = await eventReader.read()
  if (done) break
  handleGameEvent(decodeEvent(value))
}
```

## Message Format (Binary, not JSON)
Use binary encoding for datagrams — JSON is too verbose for 20 updates/second.

### Position datagram (11 bytes)
```
[playerId: 1 byte][x: 2 bytes][y: 2 bytes][angle: 2 bytes][vx: 2 bytes][vy: 2 bytes]
```

- `x`, `y`: unsigned 16-bit, mapped to canvas coordinates (0–canvas width/height)
- `angle`: unsigned 16-bit, mapped to 0–2π (0 = right, increases clockwise)
- `vx`, `vy`: signed 16-bit, scaled by 100 (e.g. 150 encodes 1.5 px/frame). Range ±327 px/frame.

### Game event (reliable stream, JSON is fine here — infrequent)
```json
{ "type": "player_died", "playerId": "abc", "killedBy": "xyz" }
{ "type": "score", "playerId": "abc", "score": 5 }
{ "type": "player_joined", "playerId": "abc", "color": "#f97316" }
{ "type": "respawn", "playerId": "abc", "x": 400, "y": 300 }
```

## Ship Physics Model

Asteroids-style: ship has inertia and drifts until friction bleeds it off.

```
// Per tick (server + client both run this)
const THRUST        = 0.2   // px/frame² added per tick while Up held
const ROTATION_RATE = 0.05  // radians per tick while Left/Right held
const FRICTION      = 0.98  // velocity multiplier per tick (bleeds momentum)
const MAX_SPEED     = 8     // px/frame cap

// Movement step
if (thrusting) {
  vx += Math.cos(angle) * THRUST
  vy += Math.sin(angle) * THRUST
}
vx *= FRICTION
vy *= FRICTION
const speed = Math.sqrt(vx*vx + vy*vy)
if (speed > MAX_SPEED) { vx = vx/speed * MAX_SPEED; vy = vy/speed * MAX_SPEED }

x = (x + vx + CANVAS_W) % CANVAS_W   // wrap edges
y = (y + vy + CANVAS_H) % CANVAS_H
```

Clients run the same physics locally for their own ship (client-side prediction) and use received `vx`/`vy` to dead-reckon other ships between 20Hz updates.

## Server Game Loop
```js
// 20 times per second — broadcast all positions to all clients
setInterval(() => {
  const snapshot = encodeAllPositions(gameState.players)
  for (const [id, client] of clients) {
    client.datagramWriter.write(snapshot)  // fire and forget
  }
}, 50)

// Collision detection — runs every tick
// When collision detected → send reliable event to all clients
function onCollision(killerId, victimId) {
  const event = JSON.stringify({ type: 'player_died', playerId: victimId, killedBy: killerId })
  for (const [id, client] of clients) {
    client.eventWriter.write(encode(event))  // guaranteed delivery
  }
}
```

## TLS Setup (Required for WebTransport)

Use `mkcert` — it installs a local CA that Chrome trusts natively. No flags, no fingerprint management.

```bash
# 1. Install mkcert (once per machine)
# Windows:  choco install mkcert   OR   scoop install mkcert
# Mac:      brew install mkcert
# Linux:    https://github.com/FiloSottile/mkcert#linux

# 2. Install the local CA into your system/browser trust store (once per machine)
mkcert -install

# 3. Generate the cert for this project
mkdir certs
mkcert -key-file certs/private-key.pem -cert-file certs/certificate.pem localhost 127.0.0.1

# 4. Start the server and open https://localhost:4433 in Chrome — no flags needed
```

> Note: the generated cert is trusted by Chrome, Firefox, and the system. No browser relaunch needed after cert regeneration as long as `mkcert -install` was run once.

## Key Concepts You'll Learn
- **Datagrams vs streams** — you'll feel the difference when you toggle between them and watch movement quality change
- **Binary encoding** — why JSON is impractical for high-frequency updates
- **Server-authoritative game loop** — server owns the truth, clients render predictions
- **QUIC connection setup** — TLS requirement, HTTP/3, why it's harder to set up than WebSockets
- **No head-of-line blocking** — multiple independent streams on one connection without interference

## What You'll Build in a Day
- [ ] Ship rendering on canvas with arrow key controls
- [ ] Position broadcast via datagrams at 20Hz
- [ ] Server-side collision detection
- [ ] Death/respawn flow over reliable streams
- [ ] Live scoreboard
- [ ] Player join/leave handling
- [ ] Color-coded ships per player

## Out of Scope (for now)
- Actual asteroids / obstacles (add on day 2)
- Bullet firing (interesting — bullets could also be datagrams)
- Lag compensation / client-side prediction
- Rooms / lobbies
- Mobile controls

## Comparison: All Three Protocols
| | WebSockets (Day 1) | SSE (Day 2) | WebTransport (Day 3) |
|---|---|---|---|
| App | Live code editor | Writing co-pilot | Multiplayer asteroids |
| Direction | Full duplex | Server → client | Full duplex + datagrams |
| Transport | TCP | HTTP/1.1 or 2 | QUIC (UDP) |
| Delivery | Reliable, ordered | Reliable, ordered | Your choice per message |
| Setup friction | Low | Very low | High (TLS, HTTP/3) |
| Best for | Collaboration | Streaming generation | Real-time games/media |

## Getting Started
```bash
npm install
mkdir certs
# Generate certs (see TLS Setup above)
node server.js
# Open http://localhost:3000 in two Chrome tabs
# Note: must be Chrome/Edge — no Safari support
```

Static files are served on **port 3000** (plain HTTP).
WebTransport runs on **port 4433** (HTTP/3 + TLS via mkcert).
