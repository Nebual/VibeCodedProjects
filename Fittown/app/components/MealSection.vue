<script setup lang="ts">
import { showsGramPortions } from '#shared/recipes'
import { portionUnits, type PortionUnit } from '#shared/portions'
import type { DiaryEntry, MealName } from '~/composables/useDiary'

const props = defineProps<{
  meal: MealName
  label: string
  entries: DiaryEntry[]
  date: string
}>()

const emit = defineEmits<{
  remove: [id: number]
  'quick-add': []
  'update-portion': [id: number, body: Record<string, unknown>]
}>()

const kcal = computed(() =>
  Math.round(props.entries.reduce((sum, e) => sum + (e.nutrients.kcal ?? 0), 0)),
)

/**
 * "1.5 × container" when a named serving was used, otherwise "150 g".
 *
 * A recipe with no stated yield never shows grams: the weight behind the entry
 * is the raw ingredient sum, and printing it next to a cooked dish would quote
 * a weight nobody measured. "1 × serving" is the whole truth there.
 */
function portion(entry: DiaryEntry) {
  const unit = entry.food.is_liquid ? 'ml' : 'g'
  const weighed = showsGramPortions(entry.food)
  if (entry.serving_label && entry.serving_count) {
    const count = Number(entry.serving_count.toFixed(2))
    const label = `${count} × ${entry.serving_label}`
    return weighed ? `${label} · ${Math.round(entry.grams)} ${unit}` : label
  }
  return weighed ? `${Math.round(entry.grams)} ${unit}` : 'serving'
}

/**
 * Re-opening an entry lands on the portion it was logged with, rather than
 * resetting to a default the user never chose.
 */
function editLink(entry: DiaryEntry) {
  const params = new URLSearchParams({
    entry: String(entry.id),
    d: props.date,
    meal: props.meal,
    g: String(entry.grams),
  })
  if (entry.serving_label) params.set('sl', entry.serving_label)
  if (entry.serving_count) params.set('sc', String(entry.serving_count))
  if (entry.amount_formula) params.set('af', entry.amount_formula)
  return `/food/${entry.food.id}?${params}`
}

// --- inline portion edit -----------------------------------------------------
// Same pattern as the recipe page's ingredient amounts: the portion text is a
// button; tapping it swaps in a small input + unit picker, and closing the
// group (focusout, Enter) saves while Esc backs out.

/** Which entry's portion is open for a quick edit, plus its unsaved draft. */
const editingEntryId = ref<number | null>(null)
const amountDraft = ref(0)
/** The arithmetic behind `amountDraft`, when it was typed as one. */
const formulaDraft = ref<string | null>(null)
const unitDraft = ref<PortionUnit>({ key: 'g', label: 'g', size: 1 })
const portionInputEl = ref<{ focus: () => void; select: () => void } | null>(null)
function setPortionInputEl(el: unknown) {
  portionInputEl.value = el as { focus: () => void; select: () => void } | null
}

watch(editingEntryId, async (opened) => {
  if (opened === null) return
  await nextTick()
  portionInputEl.value?.focus()
  portionInputEl.value?.select()
})

/** This entry's own named serving, if it was logged with one. */
function ownUnit(entry: DiaryEntry): PortionUnit | null {
  if (entry.serving_label && entry.serving_count) {
    return {
      key: 'own',
      label: entry.serving_label,
      size: entry.grams / entry.serving_count,
    }
  }
  return null
}

/** The unit this row's draft opens in: its own serving where it has one,
 *  otherwise the base weight/volume unit — matching what `portion()` prints. */
function baseChoice(entry: DiaryEntry): PortionUnit {
  const own = ownUnit(entry)
  if (own) return own
  const base = entry.food.is_liquid ? 'ml' : 'g'
  return { key: base, label: base, size: 1 }
}

function unitChoices(entry: DiaryEntry): PortionUnit[] {
  const own = ownUnit(entry)
  const list: PortionUnit[] = own ? [own] : []
  for (const choice of portionUnits(!!entry.food.is_liquid)) {
    if (own && choice.label.toLowerCase() === own.label.toLowerCase()) continue
    list.push(choice)
  }
  return list
}

function displayAmount(entry: DiaryEntry, unit: PortionUnit): number {
  if (unit.key === 'g' || unit.key === 'ml') return Math.round(entry.grams)
  return Math.round((entry.grams / unit.size) * 100) / 100
}

function startEditPortion(entry: DiaryEntry) {
  const unit = baseChoice(entry)
  editingEntryId.value = entry.id
  unitDraft.value = unit
  amountDraft.value = displayAmount(entry, unit)
  formulaDraft.value = entry.amount_formula
}

/** Switching units mid-edit re-expresses the same weight rather than keeping
 *  the number in the box and quietly changing what was eaten. */
function switchDraftUnit(unit: PortionUnit) {
  const grams = amountDraft.value * unitDraft.value.size
  unitDraft.value = unit
  amountDraft.value = Math.round((grams / unit.size) * 100) / 100
  // A unit switch recomputes the amount rather than accepting a typed one.
  formulaDraft.value = null
}

function cancelEditPortion() {
  editingEntryId.value = null
}

/**
 * Closes the editor and, if anything actually changed, saves via the parent.
 *
 * Bound to the group's `focusout`, not each control's `blur`: moving focus
 * from the amount box to the unit picker is still inside this edit.
 */
function onPortionGroupFocusOut(event: FocusEvent, entry: DiaryEntry) {
  const next = event.relatedTarget as Node | null
  const group = event.currentTarget as HTMLElement
  if (next && group.contains(next)) return
  commitPortion(entry)
}

const showQuickAdd = ref(false)

function commitPortion(entry: DiaryEntry) {
  if (editingEntryId.value !== entry.id) return
  editingEntryId.value = null

  const isBaseUnit = unitDraft.value.key === 'g' || unitDraft.value.key === 'ml'
  const grams = amountDraft.value * unitDraft.value.size
  const servingLabel = isBaseUnit ? null : unitDraft.value.label
  const servingCount = isBaseUnit ? null : amountDraft.value

  const unchanged = Math.abs(grams - entry.grams) < 0.0001
    && servingLabel === (entry.serving_label ?? null)
    && servingCount === (entry.serving_count ?? null)
  if (unchanged) return

  emit('update-portion', entry.id, {
    grams,
    serving_label: servingLabel,
    serving_count: servingCount,
    amount_formula: formulaDraft.value,
  })
}
</script>

<template>
  <section class="card bg-base-100 shadow-sm">
    <div class="card-body p-0">
      <header class="flex items-center justify-between px-4 pt-3 pb-1">
        <h2 class="font-semibold">{{ label }}</h2>
        <span class="text-sm text-base-content/60 tabular">{{ kcal }} kcal</span>
      </header>

      <ul v-if="entries.length" class="divide-y divide-base-200">
        <li
          v-for="entry in entries"
          :key="entry.id"
          class="flex items-center gap-3 px-4 py-2.5"
        >
          <div class="flex-1 min-w-0">
            <NuxtLink
              :to="editLink(entry)"
              class="block truncate font-medium text-sm hover:underline"
            >
              {{ entry.food.name }}
            </NuxtLink>
            <div
              v-if="editingEntryId === entry.id"
              class="flex items-center gap-1.5 flex-wrap"
              @focusout="onPortionGroupFocusOut($event, entry)"
            >
              <MathNumberInput
                :ref="setPortionInputEl"
                v-model="amountDraft"
                v-model:formula="formulaDraft"
                preview="chip"
                class="input input-bordered input-xs w-20 text-right tabular"
                :aria-label="`Amount of ${entry.food.name}`"
                @keydown.enter="commitPortion(entry)"
                @keydown.esc="cancelEditPortion"
              />
              <select
                class="select select-bordered select-xs w-24 truncate"
                :aria-label="`Unit for ${entry.food.name}`"
                :value="unitDraft.key"
                @change="switchDraftUnit(unitChoices(entry).find((u) => u.key === ($event.target as HTMLSelectElement).value)!)"
                @keydown.enter="commitPortion(entry)"
                @keydown.esc="cancelEditPortion"
              >
                <option v-for="choice in unitChoices(entry)" :key="choice.key" :value="choice.key">
                  {{ choice.label }}
                </option>
              </select>
            </div>
            <button
              v-else
              type="button"
              class="block text-xs truncate tabular text-base-content/60 rounded hover:bg-base-200 -mx-1 px-1"
              :aria-label="`Change amount of ${entry.food.name}`"
              @click="startEditPortion(entry)"
            >
              <span v-if="entry.food.brand">{{ entry.food.brand }} · </span>{{ portion(entry) }}
            </button>
            <!-- What was different about this one: "3 × egg instead of 4 · no
                 bacon". Only ever set on a meal logged from a recipe with
                 changes, so it costs nothing on every other row. -->
            <div
              v-if="entry.food.recipe_log_note"
              class="text-xs text-base-content/50 truncate italic"
            >
              {{ entry.food.recipe_log_note }}
            </div>
          </div>

          <div class="text-right shrink-0">
            <div class="text-sm tabular">{{ Math.round(entry.nutrients.kcal ?? 0) }}</div>
            <div class="text-[0.65rem] text-base-content/50 tabular">
              P{{ Math.round(entry.nutrients.protein_g ?? 0) }}
              C{{ Math.round(entry.nutrients.carbs_g ?? 0) }}
              F{{ Math.round(entry.nutrients.fat_g ?? 0) }}
            </div>
          </div>

          <button
            class="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-error"
            :aria-label="`Remove ${entry.food.name}`"
            @click="$emit('remove', entry.id)"
          >
            <AppIcon name="trash" class="w-4 h-4" />
          </button>
        </li>
      </ul>

      <!--
        No "nothing logged yet" placeholder: four empty meals is the normal
        state of a morning, and saying so four times pushes the rest of the day
        off the screen. The "Add food" button already says the section is empty.
      -->

      <div class="flex items-center gap-1 m-2 mt-1">
        <NuxtLink
          :to="`/add?meal=${meal}&d=${date}`"
          class="btn btn-ghost btn-sm justify-start gap-2 text-primary flex-1"
        >
          <AppIcon name="plus" class="w-4 h-4" />
          Add food
        </NuxtLink>
        <button
          class="btn btn-ghost btn-xs text-base-content/60 shrink-0"
          @click="showQuickAdd = true"
        >
          Quick add
        </button>
      </div>
    </div>

    <QuickAddDialog
      :open="showQuickAdd"
      :meal="meal"
      :date="date"
      @close="showQuickAdd = false"
      @saved="showQuickAdd = false; $emit('quick-add')"
    />
  </section>
</template>
