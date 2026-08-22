/**
 * Server-sent events feed: pushes the current snapshot on connect, then again
 * every time POST /api/essentia lands.
 */
export default defineEventHandler(async (event) => {
  const stream = createEventStream(event)

  const send = (snapshot: ReturnType<typeof getEssentia>) => {
    stream.push(JSON.stringify(snapshot)).catch(() => {})
  }

  const unsubscribe = onEssentiaChange(send)

  // Keep proxies from timing the connection out while nothing is changing.
  const heartbeat = setInterval(() => {
    stream.push({ event: 'ping', data: '' }).catch(() => {})
  }, 25_000)

  stream.onClosed(() => {
    unsubscribe()
    clearInterval(heartbeat)
  })

  send(getEssentia())

  return stream.send()
})
