/**
 * Feishu interactive-card rendering for final assistant replies.
 *
 * Only the assistant's final reply is rendered as a card, and only that card
 * uses Card JSON 2.0 with a `markdown` element. Mirrored human traffic
 * (Feishu users, `[DSH]` input, test messages) stays on plain `text` messages:
 * user-typed text must never be interpreted as Markdown by the client.
 *
 * Card JSON 2.0 requires Feishu client 7.20 or newer; clients below 7.20 keep
 * the card title but replace the body with an "upgrade client" notice. See
 * docs/DESIGN.md for the verified limits, degradation matrix and fallback
 * policy.
 */

/** Visible marker that tells every recipient the message is the assistant. */
export const ASSISTANT_CARD_TITLE = '[助手]'

/**
 * Conservative ceiling for one card message's HTTP request body, in UTF-8
 * bytes. Feishu documents a 30 KB limit for card/rich-text message bodies
 * (over limit = business code 230025); 24 KB leaves 6 KB of headroom.
 *
 * The budget is measured on the *request body*: the markdown is JSON-escaped
 * once inside the card JSON and then a second time when the card JSON becomes
 * the `content` string field of the HTTP request. Quote/backslash-heavy
 * Markdown can expand up to 4× across both escaping passes.
 */
export const CARD_REQUEST_MAX_BYTES = 24_000

/**
 * Bytes reserved on top of the (double-escaped) markdown payload for the card
 * wrapper (`schema`/`header`/`body`/element/`(i/n)` title) and the HTTP body
 * envelope (`receive_id`, `msg_type`, `content`, 46-byte uuid). The real cost
 * is below 500 bytes, so 1 KB is deliberately generous and keeps chunking
 * independent of the final part count.
 */
const CARD_REQUEST_RESERVE_BYTES = 1_024

/** Same estimate used by {@link estimateCardRequestBytes} for the envelope. */
const HTTP_ENVELOPE_BYTES = 256

export interface AssistantCardOptions {
  /** Card header title; defaults to `[助手]`. Multi-part replies append `(i/n)`. */
  readonly title?: string
}

/** Build the Card JSON 2.0 payload used for one assistant reply chunk. */
export function buildAssistantCard(markdown: string, options: AssistantCardOptions = {}): string {
  return JSON.stringify({
    schema: '2.0',
    header: {
      // plain_text keeps `[助手]` literal; template gives the card a stable
      // assistant-blue accent in the Feishu timeline.
      title: { tag: 'plain_text', content: options.title ?? ASSISTANT_CARD_TITLE },
      template: 'blue',
    },
    body: {
      elements: [{ tag: 'markdown', content: markdown }],
    },
  })
}

/**
 * Estimated HTTP request-body bytes for a card message carrying `markdown`.
 * Exposed so tests assert the real platform constraint instead of the
 * intermediate card JSON size.
 */
export function estimateCardRequestBytes(markdown: string, options: AssistantCardOptions = {}): number {
  return Buffer.byteLength(JSON.stringify(buildAssistantCard(markdown, options)), 'utf8') + HTTP_ENVELOPE_BYTES
}

/** Header title for chunk `index` (1-based) of `total` chunks. */
export function assistantCardTitle(index: number, total: number): string {
  return total > 1 ? `${ASSISTANT_CARD_TITLE} (${index}/${total})` : ASSISTANT_CARD_TITLE
}

/** Plain-text representation used when a card cannot be delivered. */
export function assistantFallbackText(markdown: string, title: string = ASSISTANT_CARD_TITLE): string {
  return `${title}\n${markdown}`
}

/**
 * Bytes `text` contributes to the request body after both escaping passes.
 * `JSON.stringify(JSON.stringify(text))` is exactly the `content` field's
 * encoding of the embedded markdown (its outer quotes are counted too).
 */
function payloadBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(text)), 'utf8')
}

/**
 * Payload cost of the escaped characters only (without the two outer quotes)
 * for an empty string: `""` -> `\"\"` -> 6 bytes. Used for additive packing.
 */
function innerPayloadBytes(text: string): number {
  return payloadBytes(text) - 6
}

function payloadBudget(maxRequestBytes: number): number {
  return Math.max(1, maxRequestBytes - CARD_REQUEST_RESERVE_BYTES)
}

export interface FenceInfo {
  readonly marker: string
  readonly info: string
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/

/** CommonMark 0-3 space fenced-code opener shared with the inline-image rewriter. */
export function openingFence(line: string): FenceInfo | undefined {
  const match = FENCE_OPEN.exec(line.endsWith('\r') ? line.slice(0, -1) : line)
  if (match === null) return undefined
  const marker = match[2] ?? ''
  const info = match[3] ?? ''
  // CommonMark forbids backticks in the info string of a backtick fence; such
  // a line is ordinary text, not a fence opener.
  if (marker.startsWith('`') && info.includes('`')) return undefined
  return { marker, info }
}

/** Whether `line` closes `fence` (same marker character, not shorter, no info text). */
export function closesFence(line: string, fence: FenceInfo): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line.endsWith('\r') ? line.slice(0, -1) : line)
  if (match === null) return false
  const marker = match[1] ?? ''
  return marker[0] === fence.marker[0] && marker.length >= fence.marker.length
}

type MarkdownUnit =
  | { readonly kind: 'text'; readonly text: string }
  | {
    readonly kind: 'fence'
    readonly opener: string
    readonly closer: string
    readonly content: readonly string[]
  }

/** Split into paragraph-ish units; fenced code blocks stay atomic. */
function scanUnits(lines: readonly string[]): MarkdownUnit[] {
  const units: MarkdownUnit[] = []
  let paragraph: string[] = []
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      units.push({ kind: 'text', text: paragraph.join('\n') })
      paragraph = []
    }
  }
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? ''
    const fence = openingFence(line)
    if (fence !== undefined) {
      flushParagraph()
      let end = index + 1
      while (end < lines.length && !closesFence(lines[end] ?? '', fence)) end += 1
      const closed = end < lines.length
      units.push({
        kind: 'fence',
        opener: line,
        // A reply usually closes its fences; an unclosed fence is closed in
        // every produced chunk so later chunks do not render as plain text.
        closer: closed ? (lines[end] ?? fence.marker) : fence.marker,
        content: lines.slice(index + 1, closed ? end : lines.length),
      })
      index = closed ? end + 1 : lines.length
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      index += 1
      continue
    }
    paragraph.push(line)
    index += 1
  }
  flushParagraph()
  return units
}

/**
 * Pack lines into rendered blocks of at most `budget` request-body payload
 * bytes. `prefix`/`suffix` wrap every block (fence opener/closer) so the
 * measured string is exactly what the card element will contain.
 */
function packLines(prefix: string, suffix: string, lines: readonly string[], budget: number): string[] {
  const render = (contentLines: readonly string[]): string => `${prefix}${contentLines.join('\n')}${suffix}`
  const parts: string[] = []
  let current: string[] = []
  const flush = (): void => {
    if (current.length > 0) {
      parts.push(render(current))
      current = []
    }
  }
  for (const line of lines) {
    if (payloadBytes(render([...current, line])) <= budget) {
      current.push(line)
      continue
    }
    flush()
    if (payloadBytes(render([line])) <= budget) {
      current.push(line)
      continue
    }
    // A single line is longer than a whole card: hard-split it at a code-point
    // boundary. Each piece is emitted as its own block, wrapped again by the
    // caller-provided fence markers when splitting a code block.
    for (const piece of splitLine(pieceWidth(prefix, suffix, budget), line, prefix, suffix, budget)) {
      parts.push(render([piece]))
    }
  }
  flush()
  return parts
}

/** Maximum payload cost of the escaped content inside the wrapper. */
function pieceWidth(prefix: string, suffix: string, budget: number): number {
  // payloadBytes(prefix + piece + suffix) = payloadBytes(prefix + suffix) + inner(piece)
  return Math.max(1, budget - payloadBytes(`${prefix}${suffix}`))
}

/** Split one over-long line into pieces whose payload cost fits `width`. */
function splitLine(width: number, line: string, prefix: string, suffix: string, budget: number): string[] {
  const pieces: string[] = []
  let piece = ''
  let used = 0
  for (const character of line) {
    const size = innerPayloadBytes(character)
    if (piece !== '' && used + size > width) {
      pieces.push(piece)
      piece = ''
      used = 0
    }
    piece += character
    used += size
  }
  if (piece !== '') pieces.push(piece)
  return pieces.filter(candidate => payloadBytes(`${prefix}${candidate}${suffix}`) <= budget)
}

/** Raw split used only when a wrapper itself cannot fit one card. */
function hardSplit(text: string, budget: number): string[] {
  // payloadBytes(piece) = payloadBytes('') + inner(piece); remove the empty
  // baseline so every piece still satisfies payloadBytes(piece) <= budget.
  const width = Math.max(1, budget - payloadBytes(''))
  const parts: string[] = []
  let current = ''
  let used = 0
  for (const character of text) {
    const size = innerPayloadBytes(character)
    if (current !== '' && used + size > width) {
      parts.push(current)
      current = ''
      used = 0
    }
    current += character
    used += size
  }
  if (current !== '') parts.push(current)
  return parts
}

function chunksForUnit(unit: MarkdownUnit, budget: number): string[] {
  if (unit.kind === 'fence') {
    const body = unit.content.join('\n')
    const whole = body === ''
      ? `${unit.opener}\n${unit.closer}`
      : `${unit.opener}\n${body}\n${unit.closer}`
    if (payloadBytes(whole) <= budget) return [whole]
    const parts = packLines(`${unit.opener}\n`, `\n${unit.closer}`, unit.content, budget)
    // A pathological opener/closer larger than a card cannot be re-fenced; fall
    // back to a raw split so no part of the reply is dropped.
    return parts.length > 0 ? parts : hardSplit(whole, budget)
  }
  if (payloadBytes(unit.text) <= budget) return [unit.text]
  const parts = packLines('', '', unit.text.split('\n'), budget)
  return parts.length > 0 ? parts : hardSplit(unit.text, budget)
}

/**
 * Split assistant Markdown into card-sized chunks without breaking fenced
 * code blocks: chunks break on paragraph boundaries, oversized fences are
 * closed and reopened with the same info string, and a line longer than one
 * card is hard-split at a code-point boundary.
 *
 * The result only depends on `markdown` and `maxRequestBytes`, so message
 * UUIDs derived from chunk indexes stay stable across retries and restarts.
 */
export function splitAssistantMarkdown(
  markdown: string,
  maxRequestBytes: number = CARD_REQUEST_MAX_BYTES,
): readonly string[] {
  if (typeof markdown !== 'string' || markdown.length === 0) return []
  const budget = payloadBudget(maxRequestBytes)
  if (payloadBytes(markdown) <= budget) return [markdown]
  // Normalize line endings only when a split is unavoidable: a chunk must not
  // end with a dangling CR whose paired LF moved to the next card.
  const normalized = markdown.replace(/\r\n?/g, '\n')
  if (payloadBytes(normalized) <= budget) return [normalized]

  const units = scanUnits(normalized.split('\n'))
  const blocks: string[] = []
  for (const unit of units) blocks.push(...chunksForUnit(unit, budget))
  if (blocks.length === 0) return [normalized]

  const chunks: string[] = []
  let current = ''
  for (const block of blocks) {
    if (block.length === 0) continue
    const candidate = current === '' ? block : `${current}\n\n${block}`
    if (payloadBytes(candidate) <= budget) {
      current = candidate
      continue
    }
    if (current !== '') chunks.push(current)
    current = block
  }
  if (current !== '') chunks.push(current)
  // Safety net: a chunk must never exceed the payload budget even if a future
  // formatting addition changes the wrapper cost.
  const safe: string[] = []
  for (const chunk of chunks) {
    if (payloadBytes(chunk) <= budget) safe.push(chunk)
    else safe.push(...hardSplit(chunk, budget))
  }
  return safe.length > 0 ? safe : [normalized]
}
