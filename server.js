import { createReadStream, stat } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as x509 from '@peculiar/x509'
import { Http3Server } from '@fails-components/webtransport'
import { players, addPlayer, removePlayer, respawnPlayer } from './game/state.js'
import { checkCollisions } from './game/physics.js'
import { encodeSnapshot, decodePositionUpdate } from './game/encode.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const enc = new TextEncoder()
const RESPAWN_MS = 3000

// ── TLS certificate (ECDSA P-256, 13-day validity) ────────────────────────
// Generated fresh each startup. Chrome allows self-signed certs for WebTransport
// when serverCertificateHashes is used AND the cert validity is ≤14 days.
// ECDSA P-256 is Chrome's preferred curve; hash computed via WebCrypto matches
// exactly how Chrome verifies it.
x509.cryptoProvider.set(globalThis.crypto)

const keyAlg = { name: 'ECDSA', namedCurve: 'P-256' }
const sigAlg = { name: 'ECDSA', hash: { name: 'SHA-256' } }
const keyPair = await globalThis.crypto.subtle.generateKey(keyAlg, true, ['sign', 'verify'])

const now = new Date()
const cert = await x509.X509CertificateGenerator.createSelfSigned({
  serialNumber: randomBytes(8).toString('hex'),
  name: 'CN=localhost',
  notBefore: now,
  notAfter: new Date(now.getTime() + 13 * 24 * 60 * 60 * 1000),
  signingAlgorithm: sigAlg,
  keys: keyPair,
  extensions: [
    new x509.BasicConstraintsExtension(false),
    new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']),
    new x509.SubjectAlternativeNameExtension([
      { type: 'dns', value: 'localhost' },
      { type: 'ip', value: '127.0.0.1' },
    ]),
  ],
})

const CERT_PEM = cert.toString('pem')

// Export private key as PKCS#8 PEM
const pkcs8Der = await globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
const pkcs8B64 = Buffer.from(pkcs8Der).toString('base64').match(/.{1,64}/g).join('\n')
const KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${pkcs8B64}\n-----END PRIVATE KEY-----\n`

// cert.rawData is the DER bytes — the same bytes Chrome hashes during verification
const hashBuf = await globalThis.crypto.subtle.digest('SHA-256', cert.rawData)
const CERT_HASH = Buffer.from(hashBuf).toString('base64')

console.log('TLS cert generated (ECDSA P-256, valid 13 days)')
console.log('Cert hash:', CERT_HASH)
console.log('Valid from:', cert.notBefore.toString())
console.log('Valid to:  ', cert.notAfter.toString())

// ── Static file server (port 3000) ────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
}

createServer((req, res) => {
  if (req.url === '/cert-hash') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ hash: CERT_HASH }))
    return
  }

  if (req.url === '/cert-info') {
    const validityMs = cert.notAfter.getTime() - cert.notBefore.getTime()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      subject:      cert.subject,
      validFrom:    cert.notBefore.toString(),
      validTo:      cert.notAfter.toString(),
      validityDays: validityMs / (1000 * 60 * 60 * 24),
      hash:         CERT_HASH,
    }))
    return
  }

  const file     = req.url === '/' ? '/index.html' : req.url
  const filePath = join(__dir, 'public', file)
  const mime     = MIME[extname(filePath)] || 'text/plain'
  stat(filePath, (err) => {
    if (err) { res.writeHead(404); res.end('Not found'); return }
    res.writeHead(200, { 'Content-Type': mime })
    createReadStream(filePath).pipe(res)
  })
}).listen(3000, () => console.log('Static files → http://localhost:3000'))

// ── WebTransport server (port 4433) ───────────────────────────────────────
const wt = new Http3Server({
  port: 4433,
  host: '0.0.0.0',
  secret: 'webtransport-game-secret',
  cert:    CERT_PEM,
  privKey: KEY_PEM,
})
wt.startServer()
console.log('WebTransport  → https://localhost:4433')

const clients = new Map() // id → { datagramWriter, eventWriter }

function sendEvent(writer, obj) {
  writer.write(enc.encode(JSON.stringify(obj) + '\n')).catch(() => {})
}

function broadcast(obj, excludeId = null) {
  for (const [id, c] of clients) {
    if (id !== excludeId) sendEvent(c.eventWriter, obj)
  }
}

async function drainDatagrams(session, id, player) {
  const reader = session.datagrams.readable.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (player.alive) {
        const pos = decodePositionUpdate(value)
        player.x     = pos.x
        player.y     = pos.y
        player.angle = pos.angle
        player.vx    = pos.vx
        player.vy    = pos.vy
      }
    }
  } catch { /* session closed */ }
}

async function handleSession(session) {
  const player = addPlayer()
  const { id, color, x, y } = player

  const datagramWriter = session.datagrams.createWritable().getWriter()
  const eventStream    = await session.createBidirectionalStream()
  const eventWriter    = eventStream.writable.getWriter()

  clients.set(id, { datagramWriter, eventWriter })

  sendEvent(eventWriter, { type: 'welcome', playerId: id, color, x, y })

  for (const [pid, p] of players) {
    if (pid !== id) {
      sendEvent(eventWriter, {
        type: 'player_joined', playerId: pid,
        color: p.color, x: p.x, y: p.y, score: p.score,
      })
    }
  }

  broadcast({ type: 'player_joined', playerId: id, color, x, y, score: 0 }, id)

  drainDatagrams(session, id, player)

  session.closed.then(() => {
    removePlayer(id)
    clients.delete(id)
    broadcast({ type: 'player_left', playerId: id })
    console.log(`Player ${id} left  (${players.size} connected)`)
  }).catch(() => {})

  console.log(`Player ${id} joined (${players.size} connected)`)
}

// Accept connections on the /game path
;(async () => {
  const reader = wt.sessionStream('/game').getReader()
  while (true) {
    const { value: session, done } = await reader.read()
    if (done) break
    handleSession(session).catch(console.error)
  }
})()

// ── Game loop (20 Hz) ─────────────────────────────────────────────────────
// Faster ship wins the collision — only the victim dies and respawns
function handleKill(killerId, victimId) {
  const killer = players.get(killerId)
  const victim = players.get(victimId)
  if (!killer || !victim) return
  victim.alive = false
  killer.score++
  broadcast({ type: 'player_died', playerId: victimId, killedBy: killerId })
  broadcast({ type: 'score',       playerId: killerId, score: killer.score })
  setTimeout(() => {
    const p = respawnPlayer(victimId)
    if (p) broadcast({ type: 'respawn', playerId: victimId, x: p.x, y: p.y })
  }, RESPAWN_MS)
}

setInterval(() => {
  for (const [aId, bId] of checkCollisions()) {
    const a = players.get(aId)
    const b = players.get(bId)
    if (!a || !b || !a.alive || !b.alive) continue
    if (Math.hypot(a.vx, a.vy) >= Math.hypot(b.vx, b.vy)) handleKill(aId, bId)
    else                                                     handleKill(bId, aId)
  }

  if (clients.size === 0) return
  const snap = encodeSnapshot(players)
  for (const [, c] of clients) {
    c.datagramWriter.write(snap).catch(() => {})
  }
}, 50)
