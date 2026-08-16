<script setup lang="ts">
import type { FoodRow } from '~/composables/useDiary'

const props = defineProps<{ meal: string; date: string }>()
const emit = defineEmits<{ close: [] }>()

const video = ref<HTMLVideoElement | null>(null)
const status = ref<'idle' | 'starting' | 'scanning' | 'unsupported' | 'denied' | 'looking-up'>('idle')
const manualCode = ref('')
const notFound = ref<string | null>(null)

let stream: MediaStream | null = null
let raf: number | undefined

/**
 * Uses the native BarcodeDetector API — no scanning library in the bundle.
 * It's available in Chrome/Edge on Android and desktop, but notably absent in
 * Safari, so manual entry is always offered alongside rather than as a
 * grudging fallback.
 */
const hasDetector = () => typeof window !== 'undefined' && 'BarcodeDetector' in window

async function start() {
  if (!hasDetector()) {
    status.value = 'unsupported'
    return
  }
  status.value = 'starting'
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    })
    if (!video.value) return
    video.value.srcObject = stream
    await video.value.play()
    status.value = 'scanning'
    detectLoop()
  } catch {
    status.value = 'denied'
    stop()
  }
}

async function detectLoop() {
  // @ts-expect-error — BarcodeDetector isn't in the DOM lib types yet.
  const detector = new window.BarcodeDetector({
    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
  })

  const tick = async () => {
    if (status.value !== 'scanning' || !video.value) return
    try {
      const codes = await detector.detect(video.value)
      if (codes.length > 0 && codes[0].rawValue) {
        await lookup(codes[0].rawValue)
        return
      }
    } catch {
      // A transient decode failure is normal between frames; keep going.
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}

async function lookup(code: string) {
  status.value = 'looking-up'
  notFound.value = null
  try {
    const { food } = await $fetch<{ food: FoodRow }>(`/api/foods/barcode/${code}`)
    stop()
    await navigateTo(`/food/${food.id}?meal=${props.meal}&d=${props.date}`)
  } catch {
    notFound.value = code
    // Resume scanning so they can try another angle or a different product.
    status.value = hasDetector() && stream ? 'scanning' : 'idle'
    if (status.value === 'scanning') detectLoop()
  }
}

function stop() {
  if (raf) cancelAnimationFrame(raf)
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
}

function close() {
  stop()
  emit('close')
}

onMounted(start)
onBeforeUnmount(stop)
</script>

<template>
  <div class="modal modal-open" role="dialog" aria-label="Scan barcode">
    <div class="modal-box max-w-md">
      <h3 class="font-semibold text-lg mb-3">Scan a barcode</h3>

      <div class="relative rounded-box overflow-hidden bg-black aspect-[4/3] grid place-items-center">
        <video
          ref="video"
          class="w-full h-full object-cover"
          muted
          playsinline
        />
        <!-- Alignment guide -->
        <div
          v-if="status === 'scanning'"
          class="absolute inset-x-6 h-24 border-2 border-primary/80 rounded-lg"
        />
        <div
          v-if="status === 'starting'"
          class="absolute inset-0 grid place-items-center text-white/70"
        >
          <span class="loading loading-spinner" />
        </div>
      </div>

      <div v-if="status === 'unsupported'" class="alert alert-info mt-3 text-sm">
        <span>This browser can't scan barcodes (Safari doesn't support it yet). Type the number instead.</span>
      </div>
      <div v-else-if="status === 'denied'" class="alert alert-warning mt-3 text-sm">
        <span>Camera access was blocked. Enter the barcode manually below.</span>
      </div>
      <div v-if="notFound" class="alert alert-error mt-3 text-sm">
        <span>No food found for {{ notFound }}. Try again or create a custom food.</span>
      </div>

      <form class="join w-full mt-3" @submit.prevent="lookup(manualCode)">
        <input
          v-model="manualCode"
          type="text"
          inputmode="numeric"
          placeholder="Enter barcode number"
          class="input input-bordered join-item flex-1"
        >
        <button
          class="btn btn-primary join-item"
          type="submit"
          :disabled="manualCode.length < 6 || status === 'looking-up'"
        >
          <span v-if="status === 'looking-up'" class="loading loading-spinner loading-xs" />
          Look up
        </button>
      </form>

      <div class="modal-action">
        <NuxtLink :to="`/food/new?meal=${meal}&d=${date}&barcode=${manualCode || notFound || ''}`" class="btn btn-ghost btn-sm">
          Create custom food
        </NuxtLink>
        <button class="btn btn-sm" @click="close">Close</button>
      </div>
    </div>
    <div class="modal-backdrop bg-black/50" @click="close" />
  </div>
</template>
