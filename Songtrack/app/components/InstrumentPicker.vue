<script setup lang="ts">
import { instrumentLabel } from '#shared/utils/instruments'

/**
 * Picks instruments to constrain a transcription to.
 *
 * Modelled on `TagPicker.vue`, with one deliberate difference: tags are free text, instruments are
 * not. The sidecar validates every name against the MT3 taxonomy and answers 422 for anything it
 * doesn't recognise, so this only ever emits values chosen from `options`.
 *
 * Thirty-five chips laid out at once is unreadable, which is what this replaces.
 */
const props = defineProps<{
  options: string[]
  disabled?: boolean
}>()

const model = defineModel<string[]>({ default: () => [] })

const query = ref('')
const open = ref(false)
const highlight = ref(0)
const inputRef = useTemplateRef<HTMLInputElement>('input')

const matches = computed(() => {
  const q = query.value.trim().toLowerCase().replace(/\s+/g, '_')
  return props.options
    .filter(name => !model.value.includes(name))
    .filter(name => !q || name.toLowerCase().includes(q))
})

watch(matches, () => { highlight.value = 0 })

// Typing reopens the menu after a pick closed it.
watch(query, (q) => { if (q) open.value = true })

function add(name: string) {
  if (!props.options.includes(name) || model.value.includes(name)) return
  model.value = [...model.value, name]
  query.value = ''
  // Close, but keep focus. Left open, the menu sits on top of the Start button underneath it and
  // swallows the click; typing again reopens it, so picking several in a row still flows.
  open.value = false
  inputRef.value?.focus()
}

function remove(name: string) {
  model.value = model.value.filter(n => n !== name)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    open.value = true
    const step = e.key === 'ArrowDown' ? 1 : -1
    const count = matches.value.length
    if (count) highlight.value = (highlight.value + step + count) % count
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const pick = matches.value[highlight.value]
    if (pick) add(pick)
    return
  }
  if (e.key === 'Escape') {
    open.value = false
    return
  }
  // Backspace on an empty box removes the last choice, as every chip input does.
  if (e.key === 'Backspace' && !query.value && model.value.length) {
    remove(model.value[model.value.length - 1]!)
  }
}

/** A click inside the menu fires blur first, so close late enough for the click to land. */
function onBlur() {
  setTimeout(() => { open.value = false }, 150)
}
</script>

<template>
  <div class="relative" data-testid="instrument-picker">
    <div v-if="model.length" class="flex flex-wrap gap-1 mb-1">
      <span
        v-for="name in model"
        :key="name"
        class="badge badge-primary gap-1"
        :data-testid="`instrument-selected-${name}`"
      >
        {{ instrumentLabel(name) }}
        <button type="button" class="ml-1" :disabled="disabled" @click="remove(name)">✕</button>
      </span>
    </div>

    <input
      ref="input"
      v-model="query"
      type="text"
      class="input input-bordered input-sm w-full"
      data-testid="instrument-search"
      :disabled="disabled"
      :placeholder="model.length ? 'Add another instrument…' : 'All instruments — type to pick specific ones'"
      @focus="open = true"
      @blur="onBlur"
      @keydown="onKeydown"
    >

    <ul
      v-if="open && matches.length"
      class="absolute z-20 mt-1 w-full menu bg-base-100 rounded-box shadow max-h-56 overflow-auto flex-nowrap"
    >
      <li v-for="(name, i) in matches" :key="name">
        <button
          type="button"
          :class="i === highlight ? 'active' : ''"
          :data-testid="`instrument-option-${name}`"
          @mousedown.prevent="add(name)"
          @mouseenter="highlight = i"
        >
          {{ instrumentLabel(name) }}
        </button>
      </li>
    </ul>

    <p v-if="open && query && !matches.length" class="text-xs text-base-content/60 mt-1">
      No instrument matches “{{ query }}”.
    </p>
  </div>
</template>
