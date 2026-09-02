/**
 * Arithmetic in a numeric field.
 *
 * Someone weighing two 140 g fillets should be able to type `140*2` rather than
 * doing the sum elsewhere and typing the answer, and the field should be able to
 * show them `140*2` again next time. This module is the whole of the arithmetic:
 * a tokenizer, a recursive-descent parser, and the rule for when a saved
 * formula may still be displayed.
 *
 * Deliberately pure and deliberately dumb, like `shared/ingredientText.ts` — no
 * database, no network, and above all **no `eval` and no `new Function`**. The
 * text comes from a person typing into a box, so it never becomes code.
 */

/**
 * Unicode vulgar fractions. Lives here rather than in `ingredientText.ts`
 * because both a pasted recipe line and a typed amount need it, and `1½`
 * meaning two different things in those two places would be a bug.
 */
export const VULGAR: Record<string, number> = {
  '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4,
  '⅕': 1 / 5, '⅖': 2 / 5, '⅗': 3 / 5, '⅘': 4 / 5,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅐': 1 / 7, '⅑': 1 / 9, '⅒': 1 / 10,
  '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8,
}

const VULGAR_CLASS = `[${Object.keys(VULGAR).join('')}]`

export type MathResult =
  /** The field is blank: no value, which is not the same as zero. */
  | { kind: 'empty' }
  /** The text is already just a number, so there is no formula worth keeping. */
  | { kind: 'plain'; value: number }
  /** A real expression, which evaluated. The text is worth keeping. */
  | { kind: 'value'; value: number }
  /** Half-typed — `100+`. Not an error; more typing fixes it. */
  | { kind: 'incomplete' }
  /** Cannot become valid by typing more. */
  | { kind: 'error'; message: string }

/**
 * A bare number, in either decimal convention. Tested against the raw text
 * before anything else: it is both the fast path and the definition of "no
 * formula to store". `1 1/2` deliberately fails it — it comes to a single
 * figure, but the text is how the user thinks of it.
 */
const PLAIN = /^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/

/**
 * `x` and `×` multiply because that is what people write on a shopping list,
 * and no unit letter is legal in these fields, so there is nothing to confuse
 * it with.
 */
const OPERATORS: Record<string, '+' | '-' | '*' | '/'> = {
  '+': '+', '-': '-',
  '*': '*', x: '*', X: '*', '×': '*',
  '/': '/', '÷': '/',
}

/**
 * One number. **Alternation order is load-bearing**, exactly as in
 * `ingredientText.ts`: `1 1/2` has to win over `1`, and `1½` over `1`, or every
 * mixed number silently loses its fraction.
 */
const NUMBER = new RegExp(
  '^(?:'
  + `(\\d+)\\s*(${VULGAR_CLASS})` // 1½
  + '|(\\d+)\\s+(\\d+)\\s*/\\s*(\\d+)' // 1 1/2
  + `|(${VULGAR_CLASS})` // ½
  + '|(\\d+(?:[.,]\\d+)?|[.,]\\d+)' // 2, 2.5, 2,5, .5
  + ')',
)

type Token =
  | { t: 'num'; v: number }
  | { t: 'op'; v: '+' | '-' | '*' | '/' }
  | { t: '(' }
  | { t: ')' }

/** Ran out of input where more was expected — the user is still typing. */
class Incomplete extends Error {}
/** Cannot be rescued by typing more. */
class Invalid extends Error {}

function numberFrom(m: RegExpExecArray): number {
  if (m[1] !== undefined && m[2] !== undefined) return Number(m[1]) + VULGAR[m[2]]!
  if (m[3] !== undefined) return Number(m[3]) + Number(m[4]) / Number(m[5])
  if (m[6] !== undefined) return VULGAR[m[6]]!
  return Number(m[7]!.replace(',', '.'))
}

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ t: ch })
      i++
      continue
    }
    // Numbers before operators: `1 1/2` starts with a digit, and its own match
    // has to consume the `/` before the operator branch sees it.
    const m = NUMBER.exec(text.slice(i))
    if (m) {
      tokens.push({ t: 'num', v: numberFrom(m) })
      i += m[0].length
      continue
    }
    const op = OPERATORS[ch]
    if (op) {
      tokens.push({ t: 'op', v: op })
      i++
      continue
    }
    return null
  }
  return tokens
}

/** expr := term (('+'|'-') term)* */
function parse(tokens: Token[]): number {
  let at = 0

  const peek = () => tokens[at]
  const next = () => tokens[at++]

  function factor(): number {
    const token = peek()
    if (!token) throw new Incomplete()
    if (token.t === 'op' && token.v === '-') {
      next()
      return -factor()
    }
    if (token.t === '(') {
      next()
      const value = expr()
      const close = peek()
      // Nothing left means the closing bracket has yet to be typed.
      if (!close) throw new Incomplete()
      if (close.t !== ')') throw new Invalid('Expected a closing bracket')
      next()
      return value
    }
    if (token.t !== 'num') throw new Invalid('Expected a number')
    next()
    return token.v
  }

  function term(): number {
    let value = factor()
    for (;;) {
      const token = peek()
      if (!token || token.t !== 'op' || (token.v !== '*' && token.v !== '/')) return value
      next()
      const right = factor()
      if (token.v === '/') {
        if (right === 0) throw new Invalid("Can't divide by zero")
        value /= right
      } else {
        value *= right
      }
    }
  }

  function expr(): number {
    let value = term()
    for (;;) {
      const token = peek()
      if (!token || token.t !== 'op' || (token.v !== '+' && token.v !== '-')) return value
      next()
      const right = term()
      value = token.v === '+' ? value + right : value - right
    }
  }

  const value = expr()
  // Anything left over is not half-typed, it is wrong: `100 40`, `100)`.
  if (at < tokens.length) throw new Invalid('Expected an operator')
  return value
}

/**
 * Evaluate what is in a numeric field.
 *
 * `min` is the field's floor — 0 for every field in the app today. A result
 * below it is an **error**, not a clamp: silently turning `100-140` into 0 puts
 * a number nobody typed into a nutrition total, which is the same reason
 * `ingredientText.ts` refuses to guess an amount.
 */
export function evaluateMath(text: string, opts: { min?: number } = {}): MathResult {
  const raw = text.trim()
  if (raw === '') return { kind: 'empty' }

  const plain = PLAIN.test(raw)
  // A spreadsheet user starts a formula with `=`; strip it and carry on.
  const body = raw.startsWith('=') ? raw.slice(1).trim() : raw
  if (body === '') return { kind: 'incomplete' }

  const tokens = tokenize(body)
  if (!tokens) return { kind: 'error', message: 'That is not a number or a sum' }
  if (tokens.length === 0) return { kind: 'incomplete' }

  let value: number
  try {
    value = parse(tokens)
  } catch (err) {
    if (err instanceof Incomplete) return { kind: 'incomplete' }
    return { kind: 'error', message: (err as Error).message }
  }

  if (!Number.isFinite(value)) return { kind: 'error', message: "That doesn't come to a number" }

  // Rounded once, here. Float noise (`0.1+0.2`) never reaches the user, and the
  // preview shows exactly the number that gets stored.
  const rounded = Math.round(value * 1e4) / 1e4

  if (opts.min !== undefined && rounded < opts.min) {
    return {
      kind: 'error',
      message: opts.min === 0
        ? 'That comes to less than zero'
        : `That comes to less than ${opts.min}`,
    }
  }

  return plain ? { kind: 'plain', value: rounded } : { kind: 'value', value: rounded }
}

/** How close a formula must land to still count as describing an amount. */
const TOLERANCE = 1e-4

/**
 * What a field should show for a stored amount and its stored formula.
 *
 * **The matching invariant.** The formula is shown only if it still evaluates
 * to the amount; otherwise the plain number is. This is what makes the stored
 * column safe — a formula can never make the field disagree with the figure the
 * app actually uses, whoever wrote the row. A copied recipe whose amount was
 * adjusted, a re-snapshotted meal, an amount re-expressed in another unit: each
 * falls back to the number with no invalidation logic of its own.
 */
export function fieldText(
  value: number | null,
  formula: string | null,
  opts: { min?: number } = {},
): string {
  if (value === null) return ''
  if (formula) {
    const result = evaluateMath(formula, opts)
    if (
      (result.kind === 'value' || result.kind === 'plain')
      && Math.abs(result.value - value) < TOLERANCE
    ) {
      return formula
    }
  }
  return String(value)
}
