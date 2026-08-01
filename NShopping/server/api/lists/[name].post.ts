import type { ListResponse } from '#shared/types'

export default defineEventHandler(async (event): Promise<ListResponse> => {
  const name = requireWritableListName(getRouterParam(event, 'name'))
  const body = await readBody<{ ops?: unknown }>(event)
  const list = await applyOps(name, body?.ops ?? [])

  return { name, rev: list.rev, items: list.items, serverTime: Date.now() }
})
