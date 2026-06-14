const CANVAS_W = 800
const CANVAS_H = 600
const V_SCALE = 100
const U16 = 65535
const TAU = Math.PI * 2

function dv(buf) {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
}

function encodeAngle(a) {
  return Math.round(((a % TAU + TAU) % TAU / TAU) * U16)
}

// Server → client: snapshot of all alive players (1 + N×11 bytes)
export function encodeSnapshot(players) {
  const alive = [...players.values()].filter(p => p.alive)
  const buf = new Uint8Array(1 + alive.length * 11)
  const view = new DataView(buf.buffer)
  view.setUint8(0, alive.length)
  let off = 1
  for (const p of alive) {
    view.setUint8(off,      p.id)
    view.setUint16(off + 1, Math.round((p.x / CANVAS_W) * U16))
    view.setUint16(off + 3, Math.round((p.y / CANVAS_H) * U16))
    view.setUint16(off + 5, encodeAngle(p.angle))
    view.setInt16(off + 7,  Math.round(p.vx * V_SCALE))
    view.setInt16(off + 9,  Math.round(p.vy * V_SCALE))
    off += 11
  }
  return buf
}

// Client → server: own position update (10 bytes, no id — server knows the sender)
export function decodePositionUpdate(buf) {
  const view = dv(buf)
  return {
    x:     (view.getUint16(0) / U16) * CANVAS_W,
    y:     (view.getUint16(2) / U16) * CANVAS_H,
    angle: (view.getUint16(4) / U16) * TAU,
    vx:    view.getInt16(6) / V_SCALE,
    vy:    view.getInt16(8) / V_SCALE,
  }
}
