<script setup lang="ts">
import { ref, computed } from 'vue'
import type { MatchView } from '~~/shared/matches'

const props = defineProps<{
  match: MatchView
  myPlayerId: string
}>()

const emit = defineEmits<{ (e: 'submitted'): void }>()

const RULES_URL = 'https://bloodbowlbase.ru/bb2025/core_rules/#post-game-sequence'

const amA = computed(() => props.match.playerA.id === props.myPlayerId)
// display from MY perspective: me vs opponent
const me = computed(() => (amA.value ? props.match.playerA : props.match.playerB))
const opp = computed(() => (amA.value ? props.match.playerB : props.match.playerA))

type Outcome = 'WIN' | 'DRAW' | 'LOSS'
const outcome = ref<Outcome>(
  props.match.reported
    ? props.match.result === 'DRAW'
      ? 'DRAW'
      : (props.match.result === 'A_WIN') === amA.value
        ? 'WIN'
        : 'LOSS'
    : 'WIN',
)
const myTds = ref(props.match.reported ? (amA.value ? props.match.touchdownsA! : props.match.touchdownsB!) : 0)
const oppTds = ref(props.match.reported ? (amA.value ? props.match.touchdownsB! : props.match.touchdownsA!) : 0)
const myCas = ref(props.match.reported ? (amA.value ? props.match.casualtiesA! : props.match.casualtiesB!) : 0)
const oppCas = ref(props.match.reported ? (amA.value ? props.match.casualtiesB! : props.match.casualtiesA!) : 0)

const overwriting = computed(() => props.match.reported)
const confirmOpen = ref(false)
const saving = ref(false)
const error = ref('')

async function doSubmit() {
  saving.value = true
  error.value = ''
  try {
    const result = outcome.value === 'WIN' ? (amA.value ? 'A_WIN' : 'B_WIN') : outcome.value === 'LOSS' ? (amA.value ? 'B_WIN' : 'A_WIN') : 'DRAW'
    const body = {
      reporterId: props.myPlayerId,
      result,
      touchdownsA: amA.value ? myTds.value : oppTds.value,
      touchdownsB: amA.value ? oppTds.value : myTds.value,
      casualtiesA: amA.value ? myCas.value : oppCas.value,
      casualtiesB: amA.value ? oppCas.value : myCas.value,
    }
    await $fetch(`/api/matches/${props.match.id}/report`, { method: 'POST', body })
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
      <div class="alert alert-info text-sm py-2">
        <span>
          You can log stats for both players.
          <a :href="RULES_URL" target="_blank" rel="noopener" class="link link-primary font-semibold">
            Post-game Sequence (League Play rules) →
          </a>
        </span>
      </div>

      <h3 class="card-title">
        {{ me.name }} <span class="opacity-50">vs</span> {{ opp.name }}
        <span class="badge badge-ghost">Round {{ match.round }}</span>
      </h3>

      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 items-end">
        <div>
          <label class="label label-text-alt opacity-70">Result</label>
          <select v-model="outcome" class="select select-bordered w-full">
            <option value="WIN">Win (3 pts)</option>
            <option value="DRAW">Draw (1 pt)</option>
            <option value="LOSS">Loss (0 pts)</option>
          </select>
        </div>
        <div>
          <label class="label label-text-alt opacity-70">{{ me.name }} — Touchdowns</label>
          <input v-model.number="myTds" type="number" min="0" max="99" class="input input-bordered w-full" />
        </div>
        <div>
          <label class="label label-text-alt opacity-70">{{ opp.name }} — Touchdowns</label>
          <input v-model.number="oppTds" type="number" min="0" max="99" class="input input-bordered w-full" />
        </div>
        <div>
          <label class="label label-text-alt opacity-70">{{ me.name }} — Casualties</label>
          <input v-model.number="myCas" type="number" min="0" max="99" class="input input-bordered w-full" />
        </div>
        <div>
          <label class="label label-text-alt opacity-70">{{ opp.name }} — Casualties</label>
          <input v-model.number="oppCas" type="number" min="0" max="99" class="input input-bordered w-full" />
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
