import type { ListResponse } from '#shared/types'

export default defineEventHandler(async (event): Promise<ListResponse> => {
  const name = requireReadableListName(getRouterParam(event, 'name'))
  const since = Number(getQuery(event).rev)
  const list = await getList(name)

  if (Number.isFinite(since) && since === list.rev) {
    return { name, rev: list.rev, unchanged: true, serverTime: Date.now() }
  }

  return { name, rev: list.rev, items: list.items, serverTime: Date.now() }
})
