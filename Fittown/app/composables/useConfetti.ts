/**
 * A short-lived confetti burst, built on the Web Animations API rather than a
 * dependency — a dozen animated divs is all "nice job" needs, and it skips
 * the bundle cost of a whole confetti library for one moment in the app.
 */
const COLORS = ['#f97316', '#22c55e', '#3b82f6', '#eab308', '#ec4899']

/** Pieces spawn steadily across this window rather than all at once, so the
 *  burst reads as a continuous shower instead of a single flash. */
const SPAWN_WINDOW_MS = 1000
const PIECE_COUNT = 90

function spawnPiece(originX: number, originY: number, colorIndex: number) {
  const piece = document.createElement('div')
  const size = 6 + Math.random() * 6
  piece.style.position = 'fixed'
  piece.style.left = `${originX}px`
  piece.style.top = `${originY}px`
  piece.style.width = `${size}px`
  piece.style.height = `${size * 0.4}px`
  piece.style.background = COLORS[colorIndex % COLORS.length]!
  piece.style.pointerEvents = 'none'
  piece.style.zIndex = '9999'
  piece.style.borderRadius = '1px'
  piece.style.willChange = 'transform, opacity'
  document.body.appendChild(piece)

  const angle = Math.random() * Math.PI * 2
  const distance = 80 + Math.random() * 160
  const dx = Math.cos(angle) * distance
  const dy = Math.sin(angle) * distance
  const rotation = Math.random() * 720 - 360

  // Same ~1.5s fall/fade per piece regardless of when in the window it spawned.
  const animation = piece.animate(
    [
      { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx * 0.6}px, ${dy - 40}px) rotate(${rotation * 0.5}deg)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy + 260}px) rotate(${rotation}deg)`, opacity: 0 },
    ],
    { duration: 1400 + Math.random() * 200, easing: 'cubic-bezier(.2,.8,.2,1)' },
  )
  animation.onfinish = () => piece.remove()
}

export function useConfetti() {
  /** Bursts outward from `origin` (viewport coords), or screen centre-top if omitted. */
  function fireConfetti(origin?: { x: number, y: number }) {
    if (typeof document === 'undefined') return
    const originX = origin?.x ?? window.innerWidth / 2
    const originY = origin?.y ?? window.innerHeight / 3

    for (let i = 0; i < PIECE_COUNT; i++) {
      const delay = (i / PIECE_COUNT) * SPAWN_WINDOW_MS + Math.random() * 15
      setTimeout(() => spawnPiece(originX, originY, i), delay)
    }
  }

  return { fireConfetti }
}
