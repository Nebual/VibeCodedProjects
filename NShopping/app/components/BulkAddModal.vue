<script setup lang="ts">
import type { Item } from '#shared/types'
import { bestMatch, splitBulkInput } from '#shared/matching'

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
  /** Items the user has already turned down for this line, so we stop suggesting them. */
  rejected: string[]
}

const dialog = useTemplateRef<HTMLDialogElement>('dialog')
const textarea = useTemplateRef<HTMLTextAreaElement>('textarea')
const draft = ref('')
const entries = ref<Entry[]>([])
const submitted = ref(false)
let nextKey = 0

const candidates = computed(() => props.list.live.value.map(item => ({ id: item.id, name: item.name })))

/** Re-matched live, so editing an unresolved line can surface a match as you type. */
const rows = computed(() => entries.value.map(entry => ({
  entry,
  item: entry.itemId ? props.list.items.value[entry.itemId] : undefined,
  suggestion: entry.status === 'unmatched'
    ? bestMatch(entry.text, candidates.value.filter(c => !entry.rejected.includes(c.id)))
    : null,
})))

const resolvedCount = computed(() => entries.value.filter(e => e.status !== 'unmatched').length)

function open() {
  draft.value = ''
  entries.value = []
  submitted.value = false
  dialog.value?.showModal()
  nextTick(() => textarea.value?.focus())
}

function close() {
  dialog.value?.close()
}

defineExpose({ open })

/** Marks an existing item as to-buy, remembering its prior state so the match can be undone. */
function claim(entry: Entry, item: Item, score: number) {
  entry.itemId = item.id
  entry.status = 'matched'
  entry.exact = score >= 0.999
  if (item.bought) {
    entry.restore = { ...item }
    props.list.setBought(item, false)
  }
  else {
    // Already on the list — nothing to undo if the user changes their mind.
    entry.restore = undefined
  }
}

function submit() {
  entries.value = splitBulkInput(draft.value).map((line) => {
    const entry: Entry = { key: nextKey++, raw: line, text: line, status: 'unmatched', exact: false, rejected: [] }
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

function addAsNew(entry: Entry) {
  const item = props.list.addItem(entry.text)
  if (!item) return
  entry.itemId = item.id
  entry.status = 'added'
  entry.exact = true
  entry.restore = undefined
}

/** Unresolves a row: undoes whatever we did, and reopens it for editing. */
function unresolve(entry: Entry) {
  const item = entry.itemId ? props.list.items.value[entry.itemId] : undefined
  if (entry.status === 'added' && item) props.list.deleteItem(item)
  else if (entry.restore) props.list.restoreItem(entry.restore)

  // Don't offer the same wrong match straight back.
  if (entry.status === 'matched' && entry.itemId) entry.rejected.push(entry.itemId)

  entry.status = 'unmatched'
  entry.itemId = undefined
  entry.restore = undefined
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
              <span v-if="entry.status === 'added' || !entry.restore" class="block text-[0.6875rem] text-base-content/50">
                {{ entry.status === 'added' ? 'added as new' : 'already to buy' }}
              </span>
            </span>
            <span v-else class="flex min-w-0 flex-1 flex-col gap-1">
              <input
                v-model="entry.text"
                class="input input-sm input-bordered w-full"
                :aria-label="`Edit ${entry.raw}`"
                @keydown.enter.prevent="suggestion ? acceptSuggestion(entry, suggestion.id, suggestion.score) : addAsNew(entry)"
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
