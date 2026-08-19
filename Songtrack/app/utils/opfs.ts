// Local-first durability for in-progress recordings: every MediaRecorder chunk
// is written straight to OPFS as it arrives, so a killed tab loses at most one
// chunk's worth of audio instead of the whole take. Network upload only
// happens once, at Save.
const ROOT_DIR = 'songtrack-recordings'

export interface SessionManifest {
  title?: string
  takes: { id: string, timelineStart: number, duration: number, mimeType: string, chunkCount: number }[]
}

function opfsSupported(): boolean {
  return typeof navigator !== 'undefined' && 'storage' in navigator && !!navigator.storage.getDirectory
}

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  const opfsRoot = await navigator.storage.getDirectory()
  return opfsRoot.getDirectoryHandle(ROOT_DIR, { create: true })
}

export async function opfsPersist() {
  if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
    await navigator.storage.persist().catch(() => {})
  }
}

export async function opfsWriteChunk(sessionId: string, takeId: string, index: number, blob: Blob) {
  if (!opfsSupported()) return
  const root = await getRoot()
  const sessionDir = await root.getDirectoryHandle(sessionId, { create: true })
  const fileHandle = await sessionDir.getFileHandle(`${takeId}.${index}.chunk`, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(blob)
  await writable.close()
}

export async function opfsWriteManifest(sessionId: string, manifest: SessionManifest) {
  if (!opfsSupported()) return
  const root = await getRoot()
  const sessionDir = await root.getDirectoryHandle(sessionId, { create: true })
  const fileHandle = await sessionDir.getFileHandle('manifest.json', { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(manifest))
  await writable.close()
}

export async function opfsReadManifest(sessionId: string): Promise<SessionManifest | null> {
  if (!opfsSupported()) return null
  const root = await getRoot()
  const sessionDir = await root.getDirectoryHandle(sessionId, { create: true })
  try {
    const fileHandle = await sessionDir.getFileHandle('manifest.json')
    const file = await fileHandle.getFile()
    return JSON.parse(await file.text())
  } catch {
    return null
  }
}

export async function opfsReadTakeBlob(sessionId: string, takeId: string, mimeType: string): Promise<Blob> {
  const root = await getRoot()
  const sessionDir = await root.getDirectoryHandle(sessionId, { create: true })
  const chunks: { index: number, file: File }[] = []
  // @ts-expect-error - FileSystemDirectoryHandle async iteration isn't in all lib.dom versions yet
  for await (const [name, handle] of sessionDir.entries()) {
    if (handle.kind !== 'file' || !name.startsWith(`${takeId}.`) || name === 'manifest.json') continue
    const index = Number(name.split('.')[1])
    chunks.push({ index, file: await (handle as FileSystemFileHandle).getFile() })
  }
  chunks.sort((a, b) => a.index - b.index)
  return new Blob(chunks.map(c => c.file), { type: mimeType })
}

export async function opfsListSessions(): Promise<string[]> {
  if (!opfsSupported()) return []
  const root = await getRoot()
  const names: string[] = []
  // @ts-expect-error - FileSystemDirectoryHandle async iteration isn't in all lib.dom versions yet
  for await (const [name] of root.entries()) {
    names.push(name)
  }
  return names
}

export async function opfsDeleteSession(sessionId: string) {
  if (!opfsSupported()) return
  const root = await getRoot()
  await root.removeEntry(sessionId, { recursive: true }).catch(() => {})
}
