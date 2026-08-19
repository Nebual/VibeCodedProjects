<script setup lang="ts">
const props = defineProps<{
  buckets: number[]
  /** 0-1 fraction across the drawn buckets, draws a playhead line if set. */
  progress?: number
  color?: string
}>()

const canvasRef = useTemplateRef<HTMLCanvasElement>('canvas')

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const width = Math.max(1, Math.floor(rect.width * dpr))
  const height = Math.max(1, Math.floor(rect.height * dpr))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)

  const buckets = props.buckets
  if (buckets.length === 0) return

  const barColor = props.color || 'oklch(70% 0.15 250)'
  const barGap = Math.max(1, Math.floor(dpr))
  const barWidth = Math.max(1, width / buckets.length - barGap)
  const mid = height / 2
  const maxAmp = Math.max(0.05, ...buckets)

  ctx.fillStyle = barColor
  buckets.forEach((v, i) => {
    const amp = Math.min(1, v / maxAmp)
    const barHeight = Math.max(dpr, amp * mid)
    const x = i * (barWidth + barGap)
    ctx.fillRect(x, mid - barHeight, barWidth, barHeight * 2)
  })

  if (props.progress !== undefined) {
    ctx.fillStyle = 'oklch(80% 0.2 30)'
    const x = Math.floor(props.progress * width)
    ctx.fillRect(x, 0, Math.max(1, dpr), height)
  }
}

watch(() => [props.buckets, props.progress], draw, { deep: false })
onMounted(() => {
  draw()
  const ro = new ResizeObserver(draw)
  if (canvasRef.value) ro.observe(canvasRef.value)
  onScopeDispose(() => ro.disconnect())
})
</script>

<template>
  <canvas ref="canvas" class="w-full h-full block" />
</template>
