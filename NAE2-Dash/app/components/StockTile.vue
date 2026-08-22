<script setup lang="ts">
import type { TargetKind } from '~~/server/utils/essentiaStore'

const props = defineProps<{
  name: string
  amount: number
  /** Set briefly after the amount moves, to draw the eye to what just changed. */
  trend?: 'up' | 'down'
  minimum?: number
  maximum?: number
  /** Icon URL. Omitted (as items are) falls back to a letter badge. */
  icon?: string
  minTitle?: string
  maxTitle?: string
  /** Items have no maximum, so the control is hidden for them. */
  hideMaximum?: boolean
}>()

const emit = defineEmits<{
  saveTarget: [kind: TargetKind, value: number | null]
}>()

type Field = 'minimums' | 'maximums'

const iconLoaded = ref(true)
const editing = ref<Field | null>(null)
// v-model on a number input implies the .number modifier, so this is a number
// once the user types — empty stays as ''.
const draft = ref<string | number>('')
const input = useTemplateRef<HTMLInputElement>('input')

const label = computed(() => props.name.charAt(0).toUpperCase() + props.name.slice(1))
const showIcon = computed(() => Boolean(props.icon) && iconLoaded.value)
const empty = computed(() => props.amount <= 0)
const belowMin = computed(() => props.minimum !== undefined && props.amount < props.minimum)
const aboveMax = computed(() =>
  !props.hideMaximum && props.maximum !== undefined && props.amount > props.maximum,
)

async function edit(field: Field) {
  const current = field === 'minimums' ? props.minimum : props.maximum
  draft.value = current === undefined ? '' : String(current)
  editing.value = field
  await nextTick()
  input.value?.select()
}

function cancel() {
  editing.value = null
  draft.value = ''
}

function commit() {
  // Enter and Escape both clear `editing` synchronously, so the blur that
  // follows either of them is a no-op — only a real defocus saves.
  const field = editing.value
  if (!field) return

  const raw = String(draft.value ?? '').trim()
  // An emptied box means "no target for this aspect".
  const value = raw === '' ? null : Number(raw)
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    cancel()
    return
  }

  const current = field === 'minimums' ? props.minimum : props.maximum
  if (value !== (current ?? null)) {
    emit('saveTarget', field, value)
  }
  cancel()
}
</script>

<template>
  <div
    class="group relative flex flex-col items-center gap-1 rounded-lg border border-base-300 bg-base-200 px-2 pb-1.5 pt-2.5 transition-all duration-500"
    :class="[
      empty ? 'opacity-45' : '',
      trend === 'up' ? 'border-success ring-2 ring-success/60' : '',
      trend === 'down' ? 'border-error ring-2 ring-error/60' : '',
    ]"
    :title="`${label}: ${amount.toLocaleString('en-US')}`"
  >
    <img
      v-if="showIcon"
      :src="icon"
      :alt="label"
      width="32"
      height="32"
      class="size-8 shrink-0 [image-rendering:pixelated]"
      @error="iconLoaded = false"
    >
    <div
      v-else
      class="flex size-8 shrink-0 items-center justify-center rounded-full bg-base-300 font-semibold text-base-content/70"
    >
      {{ label.charAt(0) }}
    </div>

    <span
      class="line-clamp-2 max-w-full text-center text-[0.65rem] uppercase leading-tight tracking-wide text-base-content/60"
    >
      {{ label }}
    </span>
    <span
      class="font-mono text-sm font-semibold tabular-nums"
      :class="[belowMin ? 'text-warning' : '', aboveMax ? 'text-success' : '']"
    >
      {{ formatAmount(amount) }}
    </span>

    <!-- Targets: tiny read-only numbers that swap to a number input on click. -->
    <div class="mt-0.5 flex w-full items-center justify-center gap-1 font-mono text-[0.6rem] leading-none">
      <input
        v-if="editing"
        ref="input"
        v-model="draft"
        type="number"
        min="0"
        step="1"
        class="no-spinner w-full rounded border border-primary/60 bg-base-100 px-1 py-0.5 text-center font-mono text-[0.6rem] tabular-nums outline-none"
        :placeholder="editing === 'minimums' ? 'min' : 'max'"
        :aria-label="`${editing === 'minimums' ? 'Minimum' : 'Maximum'} target for ${label}`"
        @keydown.enter.prevent="commit"
        @keydown.esc.prevent="cancel"
        @blur="commit"
      >

      <template v-else>
        <button
          type="button"
          class="flex-1 rounded px-0.5 py-0.5 tabular-nums transition-colors hover:bg-base-300"
          :class="belowMin ? 'text-warning' : 'text-base-content/35'"
          :title="`${minTitle ?? 'Level maintainer minimum'} for ${label} — click to edit`"
          @click="edit('minimums')"
        >
          <span v-if="minimum !== undefined">↑{{ formatAmount(minimum) }}</span>
          <span v-else class="opacity-50">↑–</span>
        </button>
        <button
          v-if="!hideMaximum"
          type="button"
          class="flex-1 rounded px-0.5 py-0.5 tabular-nums transition-colors hover:bg-base-300"
          :class="aboveMax ? 'text-success' : 'text-base-content/35'"
          :title="`${maxTitle ?? 'Centrifuge maximum'} for ${label} — click to edit`"
          @click="edit('maximums')"
        >
          <span v-if="maximum !== undefined">↓{{ formatAmount(maximum) }}</span>
          <span v-else class="opacity-50">↓–</span>
        </button>
      </template>
    </div>
  </div>
</template>
