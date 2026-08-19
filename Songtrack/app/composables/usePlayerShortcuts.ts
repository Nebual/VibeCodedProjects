/**
 * Global playback shortcuts for the persistent bottom PlayerBar: space to
 * toggle play/pause, left/right arrows to skip 10s — the same increment as
 * the bar's own skip buttons. Ignored while typing in a form field, and a
 * no-op whenever nothing is loaded in the bar (e.g. on the recorder/editor
 * pages, which have their own separate, page-local playback).
 */
export function usePlayerShortcuts() {
  const player = usePlayer()

  function onKeydown(e: KeyboardEvent) {
    if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
    const song = player.currentSong.value
    if (!song) return

    if (e.code === 'Space') {
      e.preventDefault()
      player.toggle(song)
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault()
      player.skip(-10)
    } else if (e.code === 'ArrowRight') {
      e.preventDefault()
      player.skip(10)
    }
  }

  if (import.meta.client) {
    onMounted(() => window.addEventListener('keydown', onKeydown))
    onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
  }
}
