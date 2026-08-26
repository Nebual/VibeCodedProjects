<script setup lang="ts">
import { ref, computed, watch } from 'vue'
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
const date = ref(props.match.date ?? '')

// Track whether the user has manually chosen a result. Until then the result
// is auto-derived from the touchdown totals (win for whoever leads, tie if equal).
const resultTouched = ref(!!props.match.result)

function clamp(v: number): number {
  return Math.min(99, Math.max(0, Number.isFinite(v) ? Math.floor(v) : 0))
}

// Auto-select result from touchdowns while untouched
watch([tdsA, tdsB], ([a, b]) => {
  if (!resultTouched.value) {
    const ca = clamp(a)
    const cb = clamp(b)
    result.value = ca > cb ? 'A_WIN' : cb > ca ? 'B_WIN' : 'DRAW'
  }
})

function onResultChange() {
  resultTouched.value = true
}

// manual override resets once scores change back to matching that pick? keep simple:
// provide "Auto" reset button via clicking result again is complex — add a small reset.
function step(field: 'tdsA' | 'tdsB' | 'casA' | 'casB', delta: number) {
  const r = field === 'tdsA' ? tdsA : field === 'tdsB' ? tdsB : field === 'casA' ? casA : casB
  r.value = clamp(r.value + delta)
}

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
        touchdownsA: clamp(tdsA.value),
        touchdownsB: clamp(tdsB.value),
        casualtiesA: clamp(casA.value),
        casualtiesB: clamp(casB.value),
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

      <!-- Touchdowns -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div v-for="side in [{ key: 'tdsA', label: nameA }, { key: 'tdsB', label: nameB }]" :key="side.key">
          <label class="label label-text-alt opacity-70">{{ side.label }} — Touchdowns</label>
          <div class="join w-full">
            <button class="btn btn-lg join-item flex-1" type="button" @click="step(side.key as any, -1)">−</button>
            <input
              class="input input-lg input-bordered join-item text-center text-lg font-bold"
              type="number" min="0" max="99"
              :value="side.key === 'tdsA' ? tdsA : tdsB"
              @input="(e) => { const v = clamp(Number((e.target as HTMLInputElement).value)); if (side.key==='tdsA') tdsA = v; else tdsB = v }"
            />
            <button class="btn btn-lg btn-primary join-item flex-1" type="button" @click="step(side.key as any, +1)">+</button>
          </div>
        </div>
      </div>

      <!-- Casualties -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div v-for="side in [{ key: 'casA', label: nameA }, { key: 'casB', label: nameB }]" :key="side.key">
          <label class="label label-text-alt opacity-70">{{ side.label }} — Casualties</label>
          <div class="join w-full">
            <button class="btn btn-lg join-item flex-1" type="button" @click="step(side.key as any, -1)">−</button>
            <input
              class="input input-lg input-bordered join-item text-center text-lg font-bold"
              type="number" min="0" max="99"
              :value="side.key === 'casA' ? casA : casB"
              @input="(e) => { const v = clamp(Number((e.target as HTMLInputElement).value)); if (side.key==='casA') casA = v; else casB = v }"
            />
            <button class="btn btn-lg btn-primary join-item flex-1" type="button" @click="step(side.key as any, +1)">+</button>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap gap-4 items-end">
        <div>
          <label class="label label-text-alt opacity-70">Result</label>
          <select v-model="result" class="select select-bordered w-full" @change="onResultChange">
            <option value="A_WIN">{{ nameA }} wins</option>
            <option value="DRAW">Draw</option>
            <option value="B_WIN">{{ nameB }} wins</option>
          </select>
        </div>
        <div>
          <label class="label label-text-alt opacity-70">Match date</label>
          <input v-model="date" type="date" class="input input-bordered w-full" />
        </div>
        <button v-if="resultTouched" class="btn btn-ghost btn-sm mb-1" type="button" title="Derive result from touchdowns again" @click="resultTouched = false">
          ↺ auto from TDs
        </button>
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
