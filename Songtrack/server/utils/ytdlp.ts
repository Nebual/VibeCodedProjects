import { spawn } from 'node:child_process'
import { watchUrl } from '../../shared/utils/youtube'

/**
 * yt-dlp wrapper for "import from YouTube". URL validation lives in
 * `shared/utils/youtube.ts` (the client needs the same rules); this module is the process
 * side. `buildYtDlpArgs` and `parseYtDlpStdout` are pure and unit-tested
 * (`tests/unit/ytdlp.test.ts`) — the argument list and the stdout parse carry the risk, so
 * they're kept free of any spawning.
 *
 * Two behaviours of the real binary drive the design here, both verified against yt-dlp
 * nightly rather than taken from the docs:
 *
 * 1. **A skipped video still exits 0.** `--match-filter` rejecting a video (too long) is not
 *    an error — yt-dlp exits 0 having printed nothing. So success is decided by "did we get a
 *    file path back", never by the exit code alone. Same for the `?`-less filter form: a video
 *    whose duration is *unknown* is rejected outright, which is why the cap is written
 *    `duration<?N` — the `?` lets an unknown duration through instead of silently dropping it.
 * 2. **`--print` writes to stdout, errors to stderr.** With `--no-progress` there is nothing
 *    else on stdout, so the two `--print` lines can be read positionally.
 */

/** Videos longer than this are refused — an import holds an HTTP request open for its whole download. */
export const MAX_IMPORT_DURATION_S = 3600

/** Wall-clock ceiling for one yt-dlp run; the process is killed past this. */
export const YTDLP_TIMEOUT_MS = 10 * 60_000

export interface YtDlpArgOptions {
  videoId: string
  /** Full `-o` template, including the `%(ext)s` placeholder yt-dlp fills with the real container. */
  outputTemplate: string
  maxDurationS?: number
}

export function buildYtDlpArgs(
  { videoId, outputTemplate, maxDurationS = MAX_IMPORT_DURATION_S }: YtDlpArgOptions,
): string[] {
  return [
    '--no-playlist',
    '--no-progress',
    '--no-warnings',
    // Audio-only when YouTube offers it (webm/opus or m4a — both already handled downstream);
    // `/best` covers the rare video with no separate audio stream. No --audio-format: the take
    // is re-encoded into master.ogg by renderEditList anyway, so a transcode here is wasted work.
    '-f', 'bestaudio/best',
    '--match-filter', `duration<?${maxDurationS}`,
    '-o', outputTemplate,
    '--print', 'title',
    '--print', 'after_move:filepath',
    watchUrl(videoId),
  ]
}

export interface YtDlpResult {
  title: string
  filePath: string
}

/**
 * Read the two `--print` lines back off stdout.
 *
 * Returns null when no file path came back, which is the *expected* shape for a video that
 * `--match-filter` skipped — yt-dlp exits 0 in that case, so this is the only signal.
 */
export function parseYtDlpStdout(stdout: string): YtDlpResult | null {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return null
  const [title, filePath] = lines.slice(-2) as [string, string]
  return { title: title === 'NA' ? '' : title, filePath }
}

export class YtDlpMissingError extends Error {
  constructor() {
    super('yt-dlp is not installed on this server')
  }
}

export class YtDlpFailedError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message)
  }
}

/** Pull the most useful line out of yt-dlp's stderr for showing to the user. */
export function summarizeYtDlpError(stderr: string): string {
  const errorLine = stderr
    .split('\n')
    .map(l => l.trim())
    .findLast(l => l.startsWith('ERROR:'))
  if (!errorLine) return 'The download failed.'
  const message = errorLine
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/;\s*please report this issue.*$/is, '')
    .trim()
  return message || 'The download failed.'
}

/**
 * Run yt-dlp once. Resolves with the downloaded file, or throws:
 * `YtDlpMissingError` if the binary isn't installed, `YtDlpFailedError` otherwise (including
 * the exit-0-but-skipped case, which is a user-facing "too long", not a crash).
 */
export function runYtDlp(args: string[], timeoutMs = YTDLP_TIMEOUT_MS): Promise<YtDlpResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)

    proc.stdout.on('data', d => (stdout += d.toString()))
    proc.stderr.on('data', d => (stderr += d.toString()))

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(err.code === 'ENOENT' ? new YtDlpMissingError() : err)
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (stderr.trim()) {
        const log = code === 0 ? console.log : console.error
        log(`[yt-dlp]${code === 0 ? '' : ` exit ${code}`} yt-dlp ${args.join(' ')}\n${stderr}`)
      }
      if (timedOut) {
        reject(new YtDlpFailedError('The download took too long and was cancelled.', stderr))
        return
      }
      if (code !== 0) {
        reject(new YtDlpFailedError(summarizeYtDlpError(stderr), stderr))
        return
      }
      const parsed = parseYtDlpStdout(stdout)
      if (!parsed) {
        // Exit 0 with nothing printed: --match-filter rejected it.
        reject(new YtDlpFailedError(
          `That video is longer than the ${Math.round(MAX_IMPORT_DURATION_S / 60)} minute import limit.`,
          stderr,
        ))
        return
      }
      resolve(parsed)
    })
  })
}
