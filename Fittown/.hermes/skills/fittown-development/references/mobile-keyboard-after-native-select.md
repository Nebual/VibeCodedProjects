# Raising the mobile soft keyboard after a native `<select>` change

Fittown's `PortionPicker.vue` switches portion type via a native `<select>` and then
wants to focus + select the amount `input` so the keypad opens and the number is
highlighted for immediate overwrite. The correct gesture-handling fix differs per
browser, and the "obvious" fix is wrong for half of them.

## The bug

```js
props.picker.onPortionChange()
await nextTick()
input.focus()
input.select()
```

On mobile the field gets focus and highlights, but the soft keyboard does not open.

## Per-browser rules (task-ordering, not a one-size fix)

- **iOS / Safari:** `.focus()` must run **synchronously inside the user gesture** (the
  `change` event). Any async hop — `await nextTick()` or `setTimeout` — drops you out
  of the gesture context and the keyboard never opens. Fix: `focus()` first, then
  `select()` after a tick (so the DOM holds the freshly-reset value).
- **Firefox Android:** the *opposite*. A synchronous OR microtask (`nextTick`) focus in
  the same task as the native `<select>`'s `change` is swallowed — the picker is still
  closing and still owns the gesture, so it eats the focus. The keyboard stays hidden
  even though the field is focused. The fix is to defer to a **macrotask**:

```js
function onPortionChange() {
  props.picker.onPortionChange()
  setTimeout(() => {
    input.focus()
    input.select()
  }, 0)
}
```

  By the time the macrotask runs the native control has closed and released, so the
  focus is honoured and the keypad appears. Also drop the now-unused `nextTick`
  import and the now-pointless `async` on the handler.

## Caveats

- **Not device-verifiable from the docker sandbox** — a screenshots/emulator virtual
  keyboard does not reproduce the browser's IME-gesture handling. The `setTimeout(0)`
  macrotask deferral is the widely-documented Firefox-Android remedy, but confirm on a
  real phone before declaring it fixed.
- If `setTimeout(0)` still fails on a given device, the next fallback is to abandon the
  native `<select>` for custom buttons (a real tap target), which sidesteps this whole
  class of gesture-timing bug.

## General rule

After any native `<select>`/picker interaction, "focus the next input" is a per-browser
gesture-timing problem. Reason about whether the focus must land in the same task
(sync), a microtask, or a macrotask — do not reuse a fix that worked in another browser
without checking the target.
