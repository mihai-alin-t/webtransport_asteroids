import { players, SHIP_RADIUS } from './state.js'

export function checkCollisions() {
  const alive = [...players.values()].filter(p => p.alive)
  const collisions = []
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j]
      if (Math.hypot(a.x - b.x, a.y - b.y) < SHIP_RADIUS * 2) {
        collisions.push([a.id, b.id])
      }
    }
  }
  return collisions
}
