<script setup lang="ts">
import type { Item } from '#shared/types'
import type { TagColor, TagPatch, TagSymbol } from '#shared/tags'
import type { MatchResult } from '#shared/matching'
import { MATCH_THRESHOLD, SUGGEST_THRESHOLD, bestMatch, splitBulkInput } from '#shared/matching'

type ListApi = ReturnType<typeof useShoppingList>

const props = defineProps<{ list: ListApi }>()

interface Entry {
  key: number
  /** The line exactly as pasted. Always shown, so you can see what produced a match. */
  raw: string
  /** Editable text used for re-matching once a row is unresolved. */
  text: string
  status: 'matched' | 'added' | 'unmatched'
  itemId?: string
  /** True when the note and the item name are the same thing once normalised. */
  exact: boolean
  /** How the item looked before we touched it — absent when we changed nothing. */
  restore?: Item
  /** The matched item was already to buy, so claiming it changed nothing by itself. */
  wasToBuy: boolean
  /** Items the user has already turned down for this line, so we stop suggesting them. */
  rejected: string[]
  /**
   * Held on the row as well as on the item, so a line that hasn't resolved to anything
   * yet can still be given a colour — it gets written through the moment it does.
   */
  color?: TagColor
  symbol?: TagSymbol
  /**
   * Whether the tag above is the user's instruction or merely inherited from the item this
   * row matched. The two must not be confused: an inherited tag is discarded when the match
   * is rejected, whereas a chosen one follows the row onto whatever it matches next. Tracked
   * per facet so that choosing a colour doesn't freeze the symbol, and so that an explicit
   * "no colour" stays distinguishable from never having said anything.
   */
  choseColor: boolean
  choseSymbol: boolean
}

const dialog = useTemplateRef<HTMLDialogElement>('dialog')
const textarea = useTemplateRef<HTMLTextAreaElement>('textarea')
const photoInput = useTemplateRef<HTMLInputElement>('photoInput')
const draft = ref('')
const entries = ref<Entry[]>([])
const submitted = ref(false)
const ocrLoading = ref(false)
const ocrError = ref('')
let nextKey = 0

const candidates = computed(() => props.list.live.value.map(item => ({ id: item.id, name: item.name })))

/** Re-matched live, so editing an unresolved line can surface a match as you type. */
const rows = computed(() => entries.value.map(entry => ({
  entry,
  item: entry.itemId ? props.list.items.value[entry.itemId] : undefined,
  // A lower bar than the one that claimed matches on submit: this row is already in front
  // of the user, unresolved, so the question is only whether a candidate is worth a glance.
  suggestion: entry.status === 'unmatched'
    ? bestMatch(entry.text, candidates.value.filter(c => !entry.rejected.includes(c.id)), SUGGEST_THRESHOLD)
    : null,
})))

const resolvedCount = computed(() => entries.value.filter(e => e.status !== 'unmatched').length)

function open() {
  draft.value = ''
  entries.value = []
  submitted.value = false
  tagTarget.value = null
  dialog.value?.showModal()
  nextTick(() => textarea.value?.focus())
}

function close() {
  dialog.value?.close()
}

defineExpose({ open })

/** Opens the camera (or file picker on desktop) for the take-a-photo flow. */
function triggerPhoto() {
  ocrError.value = ''
  photoInput.value?.click()
}

/** Shrinks a photo to a long edge of `maxEdge`px (respecting EXIF rotation) as a JPEG data URL. */
async function toResizedDataUrl(file: File, maxEdge = 768): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.9)
}

/** OCRs the chosen photo and drops the transcription into the draft, for you to review before matching. */
async function onPhoto(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // let the same file be chosen again after an error
  if (!file) return

  ocrLoading.value = true
  ocrError.value = ''
  try {
    const image = await toResizedDataUrl(file)
    const { text } = await $fetch<{ text: string }>('/api/ocr', { method: 'POST', body: { image } })
    const lines = text.trim()
    if (!lines) {
      ocrError.value = 'No text found in that photo.'
      return
    }
    // Append, so a photo can top up notes you've already typed. Nothing is matched yet.
    draft.value = draft.value.trim() ? `${draft.value.trim()}\n${lines}` : lines
    nextTick(() => textarea.value?.focus())
  }
  catch {
    ocrError.value = 'Couldn’t read that photo. Is the OCR server running?'
  }
  finally {
    ocrLoading.value = false
  }
}

// ------------------------------------------------------------------- tagging

/**
 * Which row the picker under the list is aimed at; null means all of them. It sits in the
 * footer rather than in a dropdown on the row because the results list scrolls, and a
 * popover opened from inside it would be clipped by its own scroll container.
 */
const tagTarget = ref<number | null>(null)

const targetEntry = computed(() => entries.value.find(entry => entry.key === tagTarget.value) ?? null)

/**
 * What the picker shows as set. Aimed at one row it is simply that row's; aimed at all of
 * them it only reports a tag they agree on, so a single tap never claims to be leaving
 * alone something it is about to overwrite.
 */
function sharedTag<K extends 'color' | 'symbol'>(key: K): Entry[K] {
  if (targetEntry.value) return targetEntry.value[key]
  const [first, ...rest] = entries.value
  if (!first) return undefined
  return rest.every(entry => entry[key] === first[key]) ? first[key] : undefined
}

const pickerColor = computed(() => sharedTag('color'))
const pickerSymbol = computed(() => sharedTag('symbol'))

function itemFor(entry: Entry): Item | undefined {
  return entry.itemId ? props.list.items.value[entry.itemId] : undefined
}

function pick(patch: TagPatch) {
  const targets = targetEntry.value ? [targetEntry.value] : entries.value
  const items: Item[] = []

  for (const entry of targets) {
    if (patch.color !== undefined) {
      entry.color = patch.color ?? undefined
      entry.choseColor = true
    }
    if (patch.symbol !== undefined) {
      entry.symbol = patch.symbol ?? undefined
      entry.choseSymbol = true
    }

    const item = itemFor(entry)
    if (!item) continue
    // Tagging is the first thing that actually changes an item which was already to buy,
    // so this is where its "before" has to be captured — otherwise Undo has nothing to
    // put back and the tag sticks to an item the user went on to reject.
    if (entry.status === 'matched') entry.restore ??= { ...item }
    items.push(item)
  }

  // One call for the lot, so tagging thirty rows green is still a single re-sort.
  if (items.length) props.list.setTags(items, patch)
}

/**
 * Pushes the row's *chosen* tags onto the item it has just resolved to. Only the chosen
 * ones: matching an untagged line against an item that is already green must not strip
 * its colour, and a tag merely inherited from some earlier, rejected match is not an
 * instruction to repaint whatever this row landed on instead.
 */
function applyHeldTag(entry: Entry, item: Item) {
  const patch: TagPatch = {}
  if (entry.choseColor) patch.color = entry.color ?? null
  if (entry.choseSymbol) patch.symbol = entry.symbol ?? null
  if (patch.color !== undefined || patch.symbol !== undefined) props.list.setTags([item], patch)
}

/** Marks an existing item as to-buy, remembering its prior state so the match can be undone. */
function claim(entry: Entry, item: Item, score: number) {
  entry.itemId = item.id
  entry.status = 'matched'
  entry.exact = score >= 0.999
  entry.wasToBuy = !item.bought
  if (item.bought) {
    entry.restore = { ...item }
    props.list.setBought(item, false)
  }
  else {
    // Already on the list — nothing to undo unless the user goes on to tag it.
    entry.restore = undefined
  }

  // What the user chose is an instruction and is written through. Facets they haven't
  // spoken about show what the matched item already wears, so a paste doesn't look like
  // it has lost the tags the list has spent weeks acquiring.
  applyHeldTag(entry, item)
  if (!entry.choseColor) entry.color = item.color
  if (!entry.choseSymbol) entry.symbol = item.symbol
}

function submit() {
  entries.value = splitBulkInput(draft.value).map((line) => {
    const entry: Entry = {
      key: nextKey++,
      raw: line,
      text: line,
      status: 'unmatched',
      exact: false,
      wasToBuy: false,
      rejected: [],
      choseColor: false,
      choseSymbol: false,
    }
    const match = bestMatch(line, candidates.value)
    const item = match ? props.list.items.value[match.id] : undefined
    if (item && match) claim(entry, item, match.score)
    return entry
  })
  submitted.value = true
}

function acceptSuggestion(entry: Entry, id: string, score: number) {
  const item = props.list.items.value[id]
  if (item) claim(entry, item, score)
}

/**
 * Enter is the key you press to get on with it, so it only takes a suggestion the matcher
 * would have claimed on its own. A weaker one is an offer, and an offer deserves the tap.
 */
function resolveFromKeyboard(entry: Entry, suggestion: MatchResult | null) {
  if (suggestion && suggestion.score >= MATCH_THRESHOLD) acceptSuggestion(entry, suggestion.id, suggestion.score)
  else addAsNew(entry)
}

function addAsNew(entry: Entry) {
  const item = props.list.addItem(entry.text)
  if (!item) return
  entry.itemId = item.id
  entry.status = 'added'
  entry.exact = true
  entry.restore = undefined
  applyHeldTag(entry, item)
}

/** Unresolves a row: undoes whatever we did, and reopens it for editing. */
function unresolve(entry: Entry) {
  const item = entry.itemId ? props.list.items.value[entry.itemId] : undefined
  if (entry.status === 'added' && item) props.list.deleteItem(item)
  else if (entry.restore) props.list.restoreItem(entry.restore)

  // Don't offer the same wrong match straight back.
  if (entry.status === 'matched' && entry.itemId) entry.rejected.push(entry.itemId)

  // Anything merely inherited goes back with the match it came from. Leaving it would let
  // a tag the user never chose be written onto whatever this row matches next.
  if (!entry.choseColor) entry.color = undefined
  if (!entry.choseSymbol) entry.symbol = undefined

  entry.status = 'unmatched'
  entry.itemId = undefined
  entry.restore = undefined
  entry.wasToBuy = false
  entry.exact = false
}
</script>

<template>
  <dialog ref="dialog" class="modal modal-bottom sm:modal-middle">
    <div class="modal-box max-h-[85dvh] sm:max-w-2xl">
      <h3 class="text-lg font-bold">
        {{ submitted ? 'Bulk add results' : 'Bulk add' }}
      </h3>

      <template v-if="!submitted">
        <p class="py-2 text-sm text-base-content/70">
          Paste your notes — one item per line, or separated by commas. They'll be matched
          against what's already on the list.
        </p>
        <textarea
          ref="textarea"
          v-model="draft"
          class="textarea textarea-bordered h-56 w-full font-mono text-sm"
          placeholder="the Breton crackers&#10;eggs x2&#10;black beans totally empty I think"
        />

        <input
          ref="photoInput"
          type="file"
          accept="image/*"
          capture="environment"
          class="hidden"
          @change="onPhoto"
        >
        <div class="mt-2 flex items-center gap-2">
          <button
            type="button"
            class="btn btn-ghost btn-sm gap-2"
            :disabled="ocrLoading"
            @click="triggerPhoto"
          >
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M4 7h3l2-2h6l2 2h3v12H4z" stroke-linejoin="round" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
            {{ ocrLoading ? 'Reading photo…' : 'Take a photo' }}
            <span v-if="ocrLoading" class="loading loading-spinner loading-xs" />
          </button>
          <span v-if="ocrError" class="text-xs text-error">{{ ocrError }}</span>
        </div>

        <div class="modal-action">
          <button type="button" class="btn btn-ghost" @click="close">
            Cancel
          </button>
          <button type="button" class="btn btn-primary" :disabled="!draft.trim()" @click="submit">
            Add items
          </button>
        </div>
      </template>

      <template v-else>
        <p class="py-2 text-sm text-base-content/70">
          Matched {{ resolvedCount }} of {{ entries.length }}.
        </p>

        <ul class="flex max-h-[56dvh] flex-col gap-1.5 overflow-y-auto">
          <li
            v-for="{ entry, item, suggestion } in rows"
            :key="entry.key"
            class="flex items-center gap-2 rounded-box border border-base-300 px-2.5 py-1.5"
          >
            <!-- Left: what was pasted. Always visible so the pairing is readable. -->
            <span class="w-2/5 min-w-0 shrink-0 truncate text-xs text-base-content/60" :title="entry.raw">
              {{ entry.raw }}
            </span>
            <span class="shrink-0 text-base-content/30" aria-hidden="true">→</span>

            <!-- Middle: what it resolved to, or the box to say otherwise. -->
            <span v-if="entry.status !== 'unmatched'" class="min-w-0 flex-1 leading-tight">
              <span class="block truncate text-sm">{{ item?.name ?? entry.text }}</span>
              <span v-if="entry.status === 'added' || entry.wasToBuy" class="block text-[0.6875rem] text-base-content/50">
                {{ entry.status === 'added' ? 'added as new' : 'already to buy' }}
              </span>
            </span>
            <span v-else class="flex min-w-0 flex-1 flex-col gap-1">
              <input
                v-model="entry.text"
                class="input input-sm input-bordered w-full"
                :aria-label="`Edit ${entry.raw}`"
                @keydown.enter.prevent="resolveFromKeyboard(entry, suggestion)"
              >
              <button
                v-if="suggestion"
                type="button"
                class="self-start truncate text-[0.6875rem] text-primary hover:underline"
                @click="acceptSuggestion(entry, suggestion.id, suggestion.score)"
              >
                Use “{{ suggestion.name }}”
              </button>
            </span>

            <!-- Right: the actions. -->
            <span class="flex shrink-0 items-center gap-1">
              <!-- Aims the footer picker at this row rather than opening one here. -->
              <button
                type="button"
                class="btn btn-ghost btn-xs gap-1 px-1.5"
                :class="tagTarget === entry.key ? 'btn-active' : ''"
                :aria-pressed="tagTarget === entry.key"
                :aria-label="`Tag ${entry.raw}`"
                @click="tagTarget = tagTarget === entry.key ? null : entry.key"
              >
                <span
                  class="size-3.5 shrink-0 rounded-full border-2"
                  :class="entry.color ? `tag-${entry.color} tag-swatch` : 'border-dashed border-base-content/40'"
                />
                <TagSymbolIcon v-if="entry.symbol" :symbol="entry.symbol" class="size-3 shrink-0 opacity-70" />
              </button>

              <!-- An inexact match is a guess, so always offer a way to say otherwise. -->
              <button
                v-if="entry.status === 'matched' && !entry.exact"
                type="button"
                class="btn btn-ghost btn-xs"
                :aria-label="`Change the match for ${entry.raw}`"
                @click="unresolve(entry)"
              >
                Change
              </button>
              <!-- Nothing to undo when the item was already to buy. -->
              <button
                v-else-if="entry.status === 'added' || (entry.status === 'matched' && entry.restore)"
                type="button"
                class="btn btn-ghost btn-xs"
                :aria-label="`Undo ${entry.raw}`"
                @click="unresolve(entry)"
              >
                Undo
              </button>
              <button
                v-if="entry.status === 'unmatched'"
                type="button"
                class="btn btn-primary btn-sm btn-square"
                :disabled="!entry.text.trim()"
                :aria-label="`Add ${entry.text} as a new item`"
                @click="addAsNew(entry)"
              >
                <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke-linecap="round" />
                </svg>
              </button>
            </span>
          </li>
        </ul>

        <div v-if="entries.length" class="mt-3 flex flex-col gap-2 rounded-box border border-base-300 bg-base-200/40 p-2.5">
          <div class="flex items-center gap-2 text-xs">
            <span class="shrink-0 font-medium">Tag</span>
            <span class="min-w-0 flex-1 truncate text-base-content/60">
              {{ targetEntry ? `“${targetEntry.text}”` : `all ${entries.length} item${entries.length === 1 ? '' : 's'}` }}
            </span>
            <button v-if="targetEntry" type="button" class="btn btn-ghost btn-xs shrink-0" @click="tagTarget = null">
              Tag all instead
            </button>
          </div>
          <TagPicker
            :color="pickerColor"
            :symbol="pickerSymbol"
            size="sm"
            role="group"
            :aria-label="targetEntry ? `Tag ${targetEntry.text}` : 'Tag all items'"
            @pick="pick"
          />
        </div>

        <div class="modal-action">
          <button type="button" class="btn btn-primary" @click="close">
            Done
          </button>
        </div>
      </template>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button>close</button>
    </form>
  </dialog>
</template>
