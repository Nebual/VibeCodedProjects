<script setup lang="ts">
import {
  canOfferMinPlayers,
  canOfferSoloable,
  MEDIA_STATUSES,
  MEDIA_TYPES,
  MIN_PLAYER_OPTIONS,
  STATUS_META,
  TYPE_META,
} from '~~/shared/types'
import type { MediaItem, MediaType } from '~~/shared/types'

// Create or edit a media entry. Pass `item` to edit; omit to create.
const props = defineProps<{ item?: MediaItem | null }>()
const emit = defineEmits<{ close: []; saved: [item: MediaItem] }>()

const { create, update, myReview } = useMedia()
const { name } = useUser()

const isEdit = computed(() => !!props.item)
/** Editing someone else's entry — you can change the details, but the review is yours. */
const isGuest = computed(
  () =>
    !!props.item &&
    props.item.owner.trim().toLowerCase() !== name.value.trim().toLowerCase(),
)
/** Reviews left by other people, shown read-only for context. */
const othersReviews = computed(
  () =>
    props.item?.reviews.filter(
      (r) => r.author.trim().toLowerCase() !== name.value.trim().toLowerCase(),
    ) ?? [],
)
const dialog = ref<HTMLDialogElement | null>(null)

const form = reactive({
  title: '',
  type: 'game' as MediaType,
  status: 'backlog' as MediaItem['status'],
  companions: [] as string[],
  lastEpisode: '',
  notes: '',
  reviewStars: 0,
  reviewMessage: '',
  minPlayers: 0 as number,
  soloable: false,
  activityDate: '',
})

// The date the item was opened with. If it comes back unchanged we omit it from
// the payload entirely, so saving an unrelated edit can't silently round the
// stored timestamp down to midday.
const originalActivityDate = ref('')

// Tracks whether the user has set Soloable themselves, so the Book default
// never overrides a deliberate choice. Declared before the watches that use it.
const soloableTouched = ref(false)

const today = todayInput()
const activityLabel = computed(() => `Last ${TYPE_META[form.type].noun}`)

// Group-size options depend on how many people are tagged right now, so they
// appear and disappear as you edit the "With" field.
const soloOffered = computed(() => canOfferSoloable(form.companions.length))
const minOffered = computed(() =>
  MIN_PLAYER_OPTIONS.filter((m) => canOfferMinPlayers(form.companions.length, m)),
)
const groupOffered = computed(() => soloOffered.value || minOffered.value.length > 0)

/** The next minimum tier still out of reach, and how many more tags it needs. */
const nextMinHint = computed(() => {
  const next = MIN_PLAYER_OPTIONS.find(
    (m) => !canOfferMinPlayers(form.companions.length, m),
  )
  return next ? { min: next, more: next - 1 - form.companions.length } : null
})

// Untagging people can invalidate a choice that was legal a moment ago.
watch(
  () => form.companions.length,
  (n) => {
    if (!canOfferSoloable(n)) form.soloable = false
    if (form.minPlayers && !canOfferMinPlayers(n, form.minPlayers)) form.minPlayers = 0
  },
)

const saving = ref(false)
const errorMsg = ref('')

// Deliberately a `watch` on the prop, not a `watchEffect`. watchEffect tracks
// everything it reads, so any read of `form.*` in here would make editing that
// field re-run this and wipe the user's input.
watch(
  () => props.item,
  (it) => {
    const activityDate = toDateInput(it?.lastActivityAt)
    form.title = it?.title ?? ''
    form.type = it?.type ?? 'game'
    form.status = it?.status ?? 'backlog'
    form.companions = it ? [...it.companions] : []
    form.lastEpisode = it?.lastEpisode ?? ''
    form.notes = it?.notes ?? ''
    const mine = it ? myReview(it) : undefined
    form.reviewStars = mine?.stars ?? 0
    form.reviewMessage = mine?.message ?? ''
    form.minPlayers = it?.minPlayers ?? 0
    // Books are solo by default; existing entries keep whatever they were saved with.
    form.soloable = it ? (it.soloable ?? false) : form.type === 'book'
    soloableTouched.value = false
    form.activityDate = activityDate
    originalActivityDate.value = activityDate
  },
  { immediate: true },
)

watch(
  () => form.type,
  (t) => {
    if (!props.item && !soloableTouched.value) form.soloable = t === 'book'
  },
)

onMounted(() => dialog.value?.showModal())

function close() {
  dialog.value?.close()
  emit('close')
}

async function save() {
  if (!form.title.trim()) {
    errorMsg.value = 'Give it a title.'
    return
  }
  saving.value = true
  errorMsg.value = ''

  // Only touch the activity date when the user actually changed it: unchanged
  // -> omit, cleared -> null, otherwise the picked day at local midday.
  const activity: { lastActivityAt?: string | null } = {}
  if (form.activityDate !== originalActivityDate.value) {
    activity.lastActivityAt = form.activityDate
      ? fromDateInput(form.activityDate)
      : null
  }

  const payload = {
    ...activity,
    title: form.title.trim(),
    type: form.type,
    status: form.status,
    companions: form.companions,
    lastEpisode: form.type === 'show' ? form.lastEpisode.trim() : '',
    notes: form.notes.trim(),
    minPlayers: form.minPlayers || null,
    soloable: form.soloable || null,
    review:
      form.reviewStars > 0
        ? {
            stars: form.reviewStars,
            message: form.reviewMessage.trim(),
            updatedAt: new Date().toISOString(),
          }
        : null,
  }
  try {
    const saved = props.item
      ? await update(props.item.id, payload)
      : await create(payload)
    emit('saved', saved)
    close()
  } catch (e: unknown) {
    errorMsg.value = (e as { statusMessage?: string }).statusMessage || 'Could not save.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <dialog ref="dialog" class="modal" @close="emit('close')">
    <div class="modal-box max-w-2xl">
      <h3 class="text-lg font-bold">
        {{ isEdit ? 'Edit' : 'Add' }} media
      </h3>

      <div class="mt-4 space-y-4">
        <!-- Title -->
        <div class="form-control">
          <label class="label"><span class="label-text">Title</span></label>
          <input
            v-model="form.title"
            type="text"
            placeholder="What is it called?"
            class="input input-bordered w-full"
            @keydown.enter="save"
          />
        </div>

        <!-- Type -->
        <div class="form-control">
          <label class="label"><span class="label-text">Type</span></label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="t in MEDIA_TYPES"
              :key="t"
              type="button"
              class="btn btn-sm"
              :class="form.type === t ? 'btn-primary' : 'btn-outline'"
              @click="form.type = t"
            >
              {{ TYPE_META[t].icon }} {{ TYPE_META[t].label }}
            </button>
          </div>
        </div>

        <!-- Status -->
        <div class="form-control">
          <label class="label"><span class="label-text">Status</span></label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="s in MEDIA_STATUSES"
              :key="s"
              type="button"
              class="btn btn-sm"
              :class="form.status === s ? 'btn-secondary' : 'btn-outline'"
              @click="form.status = s"
            >
              {{ STATUS_META[s].label }}
            </button>
          </div>
        </div>

        <!-- Last episode (shows only) -->
        <div v-if="form.type === 'show'" class="form-control">
          <label class="label">
            <span class="label-text">Last episode watched</span>
          </label>
          <input
            v-model="form.lastEpisode"
            type="text"
            placeholder="e.g. S2E6"
            class="input input-bordered w-full"
          />
        </div>

        <!-- Last activity date — drives "3 weeks ago" and the recency sort -->
        <div class="form-control">
          <label class="label">
            <span class="label-text">{{ activityLabel }}</span>
            <span class="label-text-alt opacity-60">controls where it sorts</span>
          </label>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="form.activityDate"
              type="date"
              :max="today"
              class="input input-bordered"
            />
            <button
              type="button"
              class="btn btn-sm btn-outline"
              @click="form.activityDate = today"
            >
              Today
            </button>
            <button
              v-if="form.activityDate"
              type="button"
              class="btn btn-ghost btn-sm"
              @click="form.activityDate = ''"
            >
              Clear
            </button>
          </div>
          <p class="mt-2 text-xs opacity-60">
            Backdate this to push it down the “recently active” list. Clearing it shows
            “never {{ TYPE_META[form.type].noun }}” and falls back to the date you added it.
          </p>
        </div>

        <!-- Companions -->
        <div class="form-control">
          <label class="label">
            <span class="label-text">With</span>
            <span class="label-text-alt opacity-60">tag people to share this list with them</span>
          </label>
          <PersonInput v-model="form.companions" />
        </div>

        <!-- Group size — only offerable once enough people are tagged -->
        <div v-if="groupOffered" class="form-control">
          <label class="label">
            <span class="label-text">Group size</span>
            <span class="label-text-alt opacity-60">used by the friend filter</span>
          </label>
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-if="soloOffered"
              type="button"
              class="btn btn-sm"
              :class="form.soloable ? 'btn-accent' : 'btn-outline'"
              title="Can also be enjoyed on your own"
              @click="form.soloable = !form.soloable; soloableTouched = true"
            >
              🧍 Soloable
            </button>

            <span v-if="minOffered.length" class="ml-1 text-sm opacity-60">Needs</span>
            <button
              v-if="minOffered.length"
              type="button"
              class="btn btn-sm"
              :class="!form.minPlayers ? 'btn-primary' : 'btn-outline'"
              @click="form.minPlayers = 0"
            >
              Any
            </button>
            <button
              v-for="m in minOffered"
              :key="m"
              type="button"
              class="btn btn-sm"
              :class="form.minPlayers === m ? 'btn-primary' : 'btn-outline'"
              :title="`Needs at least ${m} people, counting you`"
              @click="form.minPlayers = m"
            >
              Minimum {{ m }}
            </button>
          </div>
          <p class="mt-2 text-xs opacity-60">
            Minimums count you.
            <template v-if="nextMinHint">
              Tag {{ nextMinHint.more }} more
              {{ nextMinHint.more === 1 ? 'person' : 'people' }} to unlock “Minimum
              {{ nextMinHint.min }}”.
            </template>
          </p>
        </div>

        <!-- Notes -->
        <div class="form-control">
          <label class="label"><span class="label-text">Notes</span></label>
          <textarea
            v-model="form.notes"
            rows="2"
            placeholder="Where are you up to? Anything to remember for next time?"
            class="textarea textarea-bordered w-full"
          />
        </div>

        <!-- Review — always your own, even on someone else's entry -->
        <div class="divider text-sm opacity-70">Your review</div>
        <div class="form-control">
          <div class="flex items-center gap-3">
            <StarRating v-model="form.reviewStars" size="lg" />
            <span class="text-sm opacity-60">
              {{ form.reviewStars ? `${form.reviewStars}/5` : 'no rating yet' }}
            </span>
          </div>
          <textarea
            v-model="form.reviewMessage"
            rows="3"
            placeholder="Why did this matter to you? Write it now so future-you can get excited all over again."
            class="textarea textarea-bordered mt-3 w-full"
          />
          <p v-if="isGuest" class="mt-2 text-xs opacity-60">
            This is {{ props.item?.owner }}'s entry — your review is yours alone and won't
            replace theirs.
          </p>
        </div>

        <!-- Other people's reviews, read-only -->
        <div v-if="othersReviews.length" class="space-y-2">
          <p class="text-sm opacity-70">Also reviewed by</p>
          <div
            v-for="r in othersReviews"
            :key="r.author"
            class="rounded-box bg-base-200/60 p-3"
          >
            <div class="flex items-center gap-2">
              <StarRating :model-value="r.stars" readonly size="sm" />
              <span class="text-xs opacity-60">{{ r.author }}</span>
            </div>
            <p v-if="r.message" class="mt-1 text-sm italic opacity-90">"{{ r.message }}"</p>
          </div>
        </div>

        <p v-if="errorMsg" class="text-sm text-error">{{ errorMsg }}</p>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" @click="close">Cancel</button>
        <button class="btn btn-primary" :disabled="saving" @click="save">
          <span v-if="saving" class="loading loading-spinner loading-sm" />
          {{ isEdit ? 'Save changes' : 'Add to library' }}
        </button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button @click="emit('close')">close</button>
    </form>
  </dialog>
</template>
