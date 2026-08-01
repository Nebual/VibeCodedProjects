<script setup lang="ts">
const { name, ready, load, clear } = useUser()
const { refresh } = useMedia()
const { load: loadTheme } = useTheme()

// Resolve the stored name on the client, then load that user's media.
onMounted(async () => {
  loadTheme()
  load()
  if (name.value) await refresh()
})

watch(name, async (v) => {
  if (v) await refresh()
})

const showGate = computed(() => ready.value && !name.value)

function switchUser() {
  if (confirm('Switch user? This only changes whose lists you see on this device.')) {
    clear()
  }
}
</script>

<template>
  <div class="min-h-screen bg-base-200">
    <!-- Top navigation -->
    <div class="navbar sticky top-0 z-30 bg-base-100/90 shadow-sm backdrop-blur">
      <div class="mx-auto flex w-full max-w-6xl items-center gap-2 px-4">
        <NuxtLink to="/" class="btn btn-ghost gap-2 px-2 text-lg font-bold">
          <span>🎯</span>
          <span class="hidden sm:inline">NMediaTrack</span>
        </NuxtLink>

        <div class="ml-2 flex items-center gap-1">
          <NuxtLink to="/" class="btn btn-ghost btn-sm" active-class="btn-active">
            Library
          </NuxtLink>
          <NuxtLink to="/shared" class="btn btn-ghost btn-sm" active-class="btn-active">
            Shared
          </NuxtLink>
          <NuxtLink to="/reviews" class="btn btn-ghost btn-sm" active-class="btn-active">
            Reviews
          </NuxtLink>
        </div>

        <div class="ml-auto flex items-center gap-2">
          <div v-if="name" class="hidden text-sm opacity-70 sm:block">
            Hi, <span class="font-semibold">{{ name }}</span>
          </div>
          <ThemeToggle />
          <button v-if="name" class="btn btn-ghost btn-sm" @click="switchUser">
            Switch
          </button>
        </div>
      </div>
    </div>

    <!-- Page content -->
    <main class="mx-auto w-full max-w-6xl px-4 py-6">
      <NuxtPage />
    </main>

    <!-- Name gate overlay -->
    <NameGate v-if="showGate" />
  </div>
</template>
