<script setup lang="ts">
// Shown until the user has chosen a name. Their name is their identity: it
// decides which lists they own and which shared lists they can see.
const { name, setName } = useUser()
const draft = ref('')

function submit() {
  if (draft.value.trim()) setName(draft.value)
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-base-300/80 p-4 backdrop-blur">
    <div class="card w-full max-w-md bg-base-100 shadow-2xl">
      <div class="card-body">
        <div class="text-center">
          <div class="text-5xl">🎮📺🎬📚</div>
          <h1 class="mt-3 text-2xl font-bold">Welcome to NMediaTrack</h1>
          <p class="mt-1 text-sm opacity-70">
            Track what you're playing, watching and reading — with whom, and what you thought.
          </p>
        </div>
        <div class="form-control mt-4">
          <label class="label"><span class="label-text">What should we call you?</span></label>
          <input
            v-model="draft"
            type="text"
            placeholder="e.g. Nebual"
            class="input input-bordered w-full"
            autofocus
            @keydown.enter="submit"
          />
          <p class="mt-2 text-xs opacity-60">
            Others can tag this exact name to share a list with you. Stored locally on this device.
          </p>
        </div>
        <div class="card-actions mt-2">
          <button class="btn btn-primary w-full" :disabled="!draft.trim()" @click="submit">
            Enter
          </button>
        </div>
        <p v-if="name" class="text-center text-xs opacity-60">Currently: {{ name }}</p>
      </div>
    </div>
  </div>
</template>
