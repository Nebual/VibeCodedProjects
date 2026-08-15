<script setup lang="ts">
import type { TagColor, TagPatch, TagSymbol } from '#shared/tags'
import { TAG_COLOR_LABELS, TAG_COLORS, TAG_SYMBOL_LABELS, TAG_SYMBOLS } from '#shared/tags'

/**
 * The tag palette, as a plain row of buttons. Purely presentational — it reports the edit
 * and never applies it, which is what lets the same control drive a live list, a multi-item
 * selection and an unsaved bulk-add row.
 *
 * `color`/`symbol` are what to show as currently set. Over a mixed selection the caller
 * passes neither, and the row simply shows nothing as active; "None" is offered as its own
 * button rather than as click-the-active-one-again precisely so that clearing still works
 * when nothing is active to click.
 */
withDefaults(defineProps<{
  color?: TagColor
  symbol?: TagSymbol
  /** Nothing to apply a tag to yet. Really disabled, not just dimmed — see below. */
  disabled?: boolean
  size?: 'sm' | 'md'
}>(), { size: 'md' })

const emit = defineEmits<{ pick: [patch: TagPatch] }>()
</script>

<template>
  <!-- Every control carries `disabled` itself. Dimming the wrapper and stopping pointer
       events would still leave nine buttons in the tab order, announcing as available and
       doing nothing when activated. -->
  <div class="flex flex-wrap items-center gap-1.5" :class="disabled ? 'opacity-40' : ''">
    <button
      type="button"
      class="btn btn-circle btn-ghost border border-base-300"
      :class="size === 'sm' ? 'btn-xs' : 'btn-sm'"
      :disabled="disabled"
      :aria-pressed="!color"
      aria-label="No colour"
      title="No colour"
      @click="emit('pick', { color: null })"
    >
      <!-- The universal "none" slash, so an empty circle isn't mistaken for white. -->
      <svg class="size-3.5 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
        <path d="M5 19 19 5" stroke-linecap="round" />
      </svg>
    </button>

    <button
      v-for="option in TAG_COLORS"
      :key="option"
      type="button"
      class="tag-swatch rounded-full border-2 transition-transform"
      :class="[
        `tag-${option}`,
        size === 'sm' ? 'size-6' : 'size-7',
        color === option ? 'ring-2 ring-base-content/60 ring-offset-1 ring-offset-base-100' : 'hover:scale-110',
      ]"
      :disabled="disabled"
      :aria-pressed="color === option"
      :aria-label="TAG_COLOR_LABELS[option]"
      :title="TAG_COLOR_LABELS[option]"
      @click="emit('pick', { color: option })"
    />

    <span class="mx-0.5 h-5 w-px shrink-0 bg-base-300" aria-hidden="true" />

    <button
      v-for="option in TAG_SYMBOLS"
      :key="option"
      type="button"
      class="btn btn-circle btn-ghost border border-base-300"
      :class="[size === 'sm' ? 'btn-xs' : 'btn-sm', symbol === option ? 'btn-active' : '']"
      :disabled="disabled"
      :aria-pressed="symbol === option"
      :aria-label="TAG_SYMBOL_LABELS[option]"
      :title="TAG_SYMBOL_LABELS[option]"
      @click="emit('pick', { symbol: symbol === option ? null : option })"
    >
      <TagSymbolIcon :symbol="option" class="size-4" />
    </button>
  </div>
</template>
