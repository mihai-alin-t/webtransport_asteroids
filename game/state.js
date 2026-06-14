export const CANVAS_W = 800
export const CANVAS_H = 600
export const SHIP_RADIUS = 15

const COLORS = ['#f97316', '#3b82f6', '#22c55e', '#ef4444', '#a855f7', '#eab308', '#06b6d4', '#ec4899']

export const players = new Map()
let nextId = 1

export function addPlayer() {
  const id = nextId++
  const player = {
    id,
    color: COLORS[(id - 1) % COLORS.length],
    x: 100 + Math.random() * (CANVAS_W - 200),
    y: 100 + Math.random() * (CANVAS_H - 200),
    angle: Math.random() * Math.PI * 2,
    vx: 0,
    vy: 0,
    score: 0,
    alive: true,
  }
  players.set(id, player)
  return player
}

export function removePlayer(id) {
  players.delete(id)
}

export function respawnPlayer(id) {
  const p = players.get(id)
  if (!p) return null
  p.x = 100 + Math.random() * (CANVAS_W - 200)
  p.y = 100 + Math.random() * (CANVAS_H - 200)
  p.angle = Math.random() * Math.PI * 2
  p.vx = 0
  p.vy = 0
  p.alive = true
  return p
}
