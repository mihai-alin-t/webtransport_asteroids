const CANVAS_W = 800
const CANVAS_H = 600
const THRUST        = 0.2
const ROTATION_RATE = 0.05
const FRICTION      = 0.98
const MAX_SPEED     = 8
const V_SCALE       = 100
const U16           = 65535
const TAU           = Math.PI * 2

const canvas   = document.getElementById('canvas')
const ctx      = canvas.getContext('2d')
const statusEl = document.getElementById('status')
const scoreEl  = document.getElementById('score')
canvas.width   = CANVAS_W
canvas.height  = CANVAS_H

// ── State ─────────────────────────────────────────────────────────────────
let myId    = null
let myScore = 0
let myColor = '#ffffff'
const myShip = { x: CANVAS_W / 2, y: CANVAS_H / 2, angle: 0, vx: 0, vy: 0, alive: false }
const ships  = new Map() // id → { x, y, angle, vx, vy, color, score, alive }
const keys   = {}

// ── Input ─────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  keys[e.code] = true
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault()
})
window.addEventListener('keyup',  e => { keys[e.code] = false })
window.addEventListener('blur',   () => { for (const k in keys) keys[k] = false })

// ── Binary encoding ───────────────────────────────────────────────────────
function encodePosition(s) {
  const buf  = new Uint8Array(10)
  const view = new DataView(buf.buffer)
  view.setUint16(0, Math.round((s.x / CANVAS_W) * U16))
  view.setUint16(2, Math.round((s.y / CANVAS_H) * U16))
  view.setUint16(4, Math.round(((s.angle % TAU + TAU) % TAU / TAU) * U16))
  view.setInt16(6,  Math.round(s.vx * V_SCALE))
  view.setInt16(8,  Math.round(s.vy * V_SCALE))
  return buf
}

function decodeSnapshot(buf) {
  const view  = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const count = view.getUint8(0)
  const out   = []
  let off = 1
  for (let i = 0; i < count; i++) {
    out.push({
      id:    view.getUint8(off),
      x:     (view.getUint16(off + 1) / U16) * CANVAS_W,
      y:     (view.getUint16(off + 3) / U16) * CANVAS_H,
      angle: (view.getUint16(off + 5) / U16) * TAU,
      vx:    view.getInt16(off + 7) / V_SCALE,
      vy:    view.getInt16(off + 9) / V_SCALE,
    })
    off += 11
  }
  return out
}

// ── Physics ───────────────────────────────────────────────────────────────
function stepShip(s) {
  s.vx *= FRICTION
  s.vy *= FRICTION
  const speed = Math.hypot(s.vx, s.vy)
  if (speed > MAX_SPEED) {
    s.vx = (s.vx / speed) * MAX_SPEED
    s.vy = (s.vy / speed) * MAX_SPEED
  }
  s.x = ((s.x + s.vx) % CANVAS_W + CANVAS_W) % CANVAS_W
  s.y = ((s.y + s.vy) % CANVAS_H + CANVAS_H) % CANVAS_H
}

// ── Drawing ───────────────────────────────────────────────────────────────
function drawShip(x, y, angle, color, thrusting) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)

  if (thrusting) {
    // Thrust flame
    ctx.strokeStyle = '#ff7700'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(-9,  -4)
    ctx.lineTo(-20,  0)
    ctx.lineTo(-9,   4)
    ctx.stroke()
  }

  // Ship body — classic Asteroids triangle
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo( 20,   0)
  ctx.lineTo(-12, -10)
  ctx.lineTo( -6,   0)
  ctx.lineTo(-12,  10)
  ctx.closePath()
  ctx.stroke()

  ctx.restore()
}

// Static star field (deterministic positions using sin)
const STARS = Array.from({ length: 80 }, (_, i) => ({
  x: ((Math.sin(i * 127.1) * 0.5 + 0.5) * CANVAS_W) | 0,
  y: ((Math.sin(i * 311.7) * 0.5 + 0.5) * CANVAS_H) | 0,
}))

function drawScoreboard() {
  const rows = []
  if (myId !== null) rows.push({ id: myId, score: myScore, color: myColor, me: true })
  for (const [id, s] of ships) {
    if (id !== myId) rows.push({ id, score: s.score, color: s.color, me: false })
  }
  rows.sort((a, b) => b.score - a.score)

  const ox = CANVAS_W - 164
  const lineH = 18
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(ox - 4, 8, 160, 30 + rows.length * lineH)

  ctx.font = 'bold 11px monospace'
  ctx.fillStyle = '#555'
  ctx.fillText('SCOREBOARD', ox, 26)
  ctx.font = '12px monospace'
  rows.forEach((r, i) => {
    ctx.fillStyle = r.color
    ctx.fillText(`P${r.id}${r.me ? ' ◄' : '  '} ${r.score}`, ox, 44 + i * lineH)
  })
}

// ── Render + physics loop ─────────────────────────────────────────────────
let datagramWriter = null

function loop() {
  const thrusting = myShip.alive && !!keys['ArrowUp']

  // Own ship input + physics
  if (myShip.alive) {
    if (keys['ArrowLeft'])  myShip.angle -= ROTATION_RATE
    if (keys['ArrowRight']) myShip.angle += ROTATION_RATE
    if (thrusting) {
      myShip.vx += Math.cos(myShip.angle) * THRUST
      myShip.vy += Math.sin(myShip.angle) * THRUST
    }
    stepShip(myShip)
    datagramWriter?.write(encodePosition(myShip)).catch(() => {})
  }

  // Dead-reckon remote ships between 20 Hz snapshots
  for (const [, s] of ships) {
    if (s.alive) stepShip(s)
  }

  // ── Render ──────────────────────────────────────────────────────────
  ctx.fillStyle = '#07070f'
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  for (const s of STARS) ctx.fillRect(s.x, s.y, 1, 1)

  for (const [id, s] of ships) {
    if (id !== myId && s.alive) drawShip(s.x, s.y, s.angle, s.color, false)
  }

  if (myId !== null && myShip.alive) {
    drawShip(myShip.x, myShip.y, myShip.angle, myColor, thrusting)
  }

  if (myId !== null && !myShip.alive) {
    ctx.textAlign = 'center'
    ctx.font = 'bold 30px monospace'
    ctx.fillStyle = '#ff3333'
    ctx.fillText('DESTROYED', CANVAS_W / 2, CANVAS_H / 2 - 16)
    ctx.font = '15px monospace'
    ctx.fillStyle = '#666'
    ctx.fillText('Respawning in 3s…', CANVAS_W / 2, CANVAS_H / 2 + 16)
    ctx.textAlign = 'left'
  }

  drawScoreboard()
  requestAnimationFrame(loop)
}

// ── Event handling ────────────────────────────────────────────────────────
function handleEvent(ev) {
  switch (ev.type) {
    case 'welcome':
      myId    = ev.playerId
      myColor = ev.color
      myShip.x = ev.x
      myShip.y = ev.y
      myShip.alive = true
      statusEl.textContent = `Player ${myId}`
      statusEl.style.color = myColor
      break

    case 'player_joined':
      ships.set(ev.playerId, {
        x: ev.x, y: ev.y, angle: 0, vx: 0, vy: 0,
        color: ev.color, score: ev.score ?? 0, alive: true,
      })
      break

    case 'player_left':
      ships.delete(ev.playerId)
      break

    case 'player_died':
      if (ev.playerId === myId) {
        myShip.alive = false
      } else {
        const s = ships.get(ev.playerId)
        if (s) s.alive = false
      }
      break

    case 'respawn':
      if (ev.playerId === myId) {
        myShip.x = ev.x; myShip.y = ev.y
        myShip.vx = 0;   myShip.vy = 0
        myShip.alive = true
        statusEl.textContent = `Player ${myId}`
        statusEl.style.color = myColor
      } else {
        const s = ships.get(ev.playerId)
        if (s) { s.x = ev.x; s.y = ev.y; s.vx = 0; s.vy = 0; s.alive = true }
      }
      break

    case 'score':
      if (ev.playerId === myId) {
        myScore = ev.score
        scoreEl.textContent = `Score: ${myScore}`
      } else {
        const s = ships.get(ev.playerId)
        if (s) s.score = ev.score
      }
      break
  }
}

// ── WebTransport connection ───────────────────────────────────────────────
async function connect() {
  // Fetch the cert hash so Chrome can verify the self-signed cert without a
  // trusted CA. Chrome requires the cert to be ≤14 days old for this to work.
  const { hash } = await fetch('/cert-hash').then(r => r.json())
  const hashBytes = Uint8Array.from(atob(hash), c => c.charCodeAt(0))

  const transport = new WebTransport('https://127.0.0.1:4433/game', {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: hashBytes.buffer }],
  })
  await transport.ready

  datagramWriter = transport.datagrams.writable.getWriter()

  // Receive position snapshots (unreliable datagrams)
  ;(async () => {
    const reader = transport.datagrams.readable.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        for (const s of decodeSnapshot(value)) {
          if (s.id === myId) continue
          const existing = ships.get(s.id)
          if (existing) {
            // Snap to server position — dead-reckoning picks up from here
            existing.x     = s.x
            existing.y     = s.y
            existing.angle = s.angle
            existing.vx    = s.vx
            existing.vy    = s.vy
          }
        }
      }
    } catch { /* closed */ }
  })()

  // Receive game events (reliable bidi stream, server-initiated)
  ;(async () => {
    const streamReader = transport.incomingBidirectionalStreams.getReader()
    const { value: stream } = await streamReader.read()
    const reader  = stream.readable.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop() // keep any incomplete trailing fragment
        for (const line of lines) {
          if (line.trim()) handleEvent(JSON.parse(line))
        }
      }
    } catch { /* closed */ }
  })()

  transport.closed.then(() => {
    datagramWriter = null
    statusEl.textContent = 'Disconnected — reload to reconnect'
    statusEl.style.color = '#ff4444'
  })
}

connect().catch(err => {
  statusEl.textContent = `Connection failed: ${err.message}`
  statusEl.style.color = '#ff4444'
  console.error('WebTransport failed:', err.message, '| source:', err.source, '| code:', err.streamErrorCode)
})

requestAnimationFrame(loop)
