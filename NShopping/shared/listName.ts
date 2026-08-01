const ADJECTIVES = [
  'amber', 'brisk', 'clever', 'dusty', 'eager', 'fuzzy', 'golden', 'humble',
  'jolly', 'keen', 'lucky', 'mellow', 'nimble', 'olive', 'plucky', 'quiet',
  'ripe', 'sunny', 'tidy', 'velvet', 'wild', 'zesty',
]

const NOUNS = [
  'basket', 'cabbage', 'crumpet', 'dumpling', 'espresso', 'fennel', 'granola',
  'hazelnut', 'juniper', 'kumquat', 'lentil', 'mango', 'noodle', 'oatcake',
  'pepper', 'quince', 'radish', 'saffron', 'trolley', 'umeboshi', 'vanilla', 'walnut',
]

/** Filenames are user-visible URLs, so keep them to a boring, path-traversal-proof shape. */
const LIST_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/** e.g. `amber-mango-prz.backup-2026-07-30` — a frozen copy, readable but never writable. */
const BACKUP_NAME_RE = /^([a-z0-9][a-z0-9-]{0,63})\.backup-(\d{4}-\d{2}-\d{2})$/

export function isValidListName(name: unknown): name is string {
  return typeof name === 'string' && LIST_NAME_RE.test(name)
}

export function isBackupName(name: unknown): name is string {
  return typeof name === 'string' && BACKUP_NAME_RE.test(name)
}

/** Both live lists and their backups can be loaded; only live lists can be written. */
export function isReadableListName(name: unknown): name is string {
  return isValidListName(name) || isBackupName(name)
}

/** Splits `list.backup-2026-07-30` into its source list and date, or null if it isn't a backup. */
export function parseBackupName(name: string): { source: string, date: string } | null {
  const match = BACKUP_NAME_RE.exec(name)
  return match ? { source: match[1]!, date: match[2]! } : null
}

/** Local date, so "one backup a day" lines up with the day the shopping actually happened. */
export function backupNameFor(listName: string, date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${listName}.backup-${year}-${month}-${day}`
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

export function generateListName(): string {
  const suffix = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`
}
