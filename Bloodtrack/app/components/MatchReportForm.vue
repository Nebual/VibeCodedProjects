<script setup lang="ts">
import { ref, computed } from 'vue'
import type { MatchView } from '~~/shared/matches'

const props = defineProps<{
  match: MatchView
  /** A participant player id, or '__admin__' when the league admin reports. */
  reporterId: string
}>()

const emit = defineEmits<{ (e: 'submitted'): void }>()

const RULES_URL = 'https://bloodbowlbase.ru/bb2025/core_rules/#post-game-sequence'

const isAdmin = computed(() => props.reporterId === '__admin__')
const nameA = computed(() => props.match.playerA.name)
const nameB = computed(() => props.match.playerB.name)

type Result = 'A_WIN' | 'B_WIN' | 'DRAW'
const result = ref<Result>(props.match.result ?? 'DRAW')
const tdsA = ref(props.match.touchdownsA ?? 0)
const tdsB = ref(props.match.touchdownsB ?? 0)
const casA = ref(props.match.casualtiesA ?? 0)
const casB = ref(props.match.casualtiesB ?? 0)
// keep date editable alongside stats
const date = ref(props.match.date ?? '')

const overwriting = computed(() => props.match.reported)
const confirmOpen = ref(false)
const saving = ref(false)
const error = ref('')

async function doSubmit() {
  saving.value = true
  error.value = ''
  try {
    await $fetch(`/api/matches/${props.match.id}/report`, {
      method: 'POST',
      body: {
        reporterId: props.reporterId,
        result: result.value,
        touchdownsA: tdsA.value,
        touchdownsB: tdsB.value,
        casualtiesA: casA.value,
        casualtiesB: casB.value,
        ...(date.value ? { date: date.value } : {}),
      },
    })
    emit('submitted')
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? 'Failed to submit report'
  } finally {
    saving.value = false
    confirmOpen.value = false
  }
}

function submit() {
  if (overwriting.value) confirmOpen.value = true
  else void doSubmit()
}
</script>

<template>
  <div class="card bg-base-100 shadow">
    <div class="card-body gap-4">
      <div v-if="!isAdmin" class="alert alert-info text-sm py-2">
        <span>
          You can log stats for both players.
          <a :href="RULES_URL" target="_blank" rel="noopener" class="link link-primary font-semibold">
            Post-game Sequence (League Play rules) →
          </a>
        </span>
      </div>

      <h3 class="card-title">
        {{ nameA }} <span class="opacity-50">vs</span> {{ nameB }}
        <span class="badge badge-ghost">Round {{ match.round }}</span>
      </h3>

      <div class="grid grid-cols-2 gap-4 items-end">
        <div>
          <label class="label label-text-alt opacity-70">{{ nameA }} — Touchdowns</label>
          <input v-model.number="tdsA" type="number" min="0" max="99" class="input input-bordered w-full" />
        </div>
        <div>
          <label class="label label-text-alt opacity-70">{{ nameB }} — Touchdowns</label>
          <input v-model.number="tdsB" type="number" min="0" max="99" class="input input-bordered w-full" />
        </div>
        <div>
          <label class="label label-text-alt opacity-70">{{ nameA }} — Casualties</label>
          <input v-model.number="casA" type="number" min="0" max="99" class="input input-bordered w-full" />
        </div>
        <div>
          <label class="label label-text-alt opacity-70">{{ nameB }} — Casualties</label>
          <input v-model.number="casB" type="number" min="0" max="99" class="input input-bordered w-full" />
        </div>
      </div>

      <div class="flex flex-wrap gap-4">
        <div>
          <label class="label label-text-alt opacity-70">Result</label>
          <select v-model="result" class="select select-bordered w-full">
            <option value="A_WIN">{{ nameA }} wins</option>
            <option value="DRAW">Draw</option>
            <option value="B_WIN">{{ nameB }} wins</option>
          </select>
        </div>
        <div>
          <label class="label label-text-alt opacity-70">Match date</label>
          <input v-model="date" type="date" class="input input-bordered w-full" />
        </div>
      </div>

      <p v-if="error" class="text-error text-sm">{{ error }}</p>

      <button class="btn btn-primary w-fit" :disabled="saving" @click="submit">
        {{ saving ? 'Saving…' : 'Submit report' }}
      </button>

      <dialog :open="confirmOpen" class="modal">
        <div class="modal-box">
          <h3 class="font-bold text-lg">Overwrite existing report?</h3>
          <p class="py-2 text-sm opacity-70">This match already has a reported result. Submitting will replace it.</p>
          <div class="modal-action">
            <button class="btn btn-ghost" @click="confirmOpen = false">Cancel</button>
            <button class="btn btn-warning" :disabled="saving" @click="doSubmit">Overwrite</button>
          </div>
        </div>
        <button class="modal-backdrop" @click="confirmOpen = false"></button>
      </dialog>
    </div>
  </div>
</template>
