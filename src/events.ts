/** Validation and extraction for the Feishu im.message.receive_v1 event. */

export interface FeishuMessageEvent {
  readonly event_id?: unknown
  readonly header?: { readonly event_id?: unknown }
  readonly sender?: {
    readonly sender_id?: { readonly open_id?: unknown }
    readonly sender_type?: unknown
    readonly name?: unknown
  }
  readonly message?: {
    readonly message_id?: unknown
    readonly chat_id?: unknown
    readonly chat_type?: unknown
    readonly message_type?: unknown
    readonly content?: unknown
    readonly mentions?: readonly { readonly key?: unknown }[]
  }
}

export interface InboundMessage {
  readonly eventId: string
  readonly messageId: string
  readonly openId: string
  readonly chatId: string
  readonly label: string
  readonly text: string
}

export type EventExtraction =
  | { readonly kind: 'message'; readonly message: InboundMessage }
  | { readonly kind: 'ignored'; readonly reason: 'bot' | 'group' | 'unsupported' | 'empty' }

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function contentRecord(content: unknown): Record<string, unknown> | undefined {
  if (typeof content === 'string') {
    try {
      const parsed: unknown = JSON.parse(content)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return undefined
    }
  }
  return content !== null && typeof content === 'object' && !Array.isArray(content)
    ? content as Record<string, unknown>
    : undefined
}

function withoutMentions(text: string, event: FeishuMessageEvent): string {
  let result = text
  for (const mention of event.message?.mentions ?? []) {
    const key = stringValue(mention.key)
    if (key !== undefined) result = result.replaceAll(key, '')
  }
  return result.trim()
}

function extractText(event: FeishuMessageEvent): string | undefined {
  const content = contentRecord(event.message?.content)
  if (content === undefined) return undefined
  if (event.message?.message_type === 'text') {
    return typeof content.text === 'string' ? withoutMentions(content.text, event) : undefined
  }
  if (event.message?.message_type !== 'post') return undefined
  const lines: string[] = []
  if (typeof content.title === 'string' && content.title.trim()) lines.push(content.title.trim())
  if (!Array.isArray(content.content)) return undefined
  for (const paragraph of content.content) {
    if (!Array.isArray(paragraph)) continue
    let line = ''
    for (const node of paragraph) {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) continue
      const element = node as Record<string, unknown>
      if ((element.tag === 'text' || element.tag === 'a' || element.tag === 'link')
        && typeof element.text === 'string') line += element.text
    }
    line = withoutMentions(line, event)
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

function shortId(openId: string): string {
  if (openId.length <= 12) return openId
  return `${openId.slice(0, 6)}…${openId.slice(-4)}`
}

/**
 * MVP accepts direct user text/post messages only. Rejecting bot and group events
 * here is the first anti-echo boundary and deliberately keeps group fan-out out
 * of the shared-session security model.
 */
export function extractInboundMessage(event: FeishuMessageEvent): EventExtraction {
  if (event.sender?.sender_type !== 'user') return { kind: 'ignored', reason: 'bot' }
  if (event.message?.chat_type !== 'p2p') return { kind: 'ignored', reason: 'group' }
  const eventId = stringValue(event.event_id) ?? stringValue(event.header?.event_id)
  const messageId = stringValue(event.message.message_id)
  const openId = stringValue(event.sender.sender_id?.open_id)
  const chatId = stringValue(event.message.chat_id)
  if (eventId === undefined || messageId === undefined || openId === undefined || chatId === undefined) {
    throw new Error('invalid Feishu message event: event_id, message_id, open_id and chat_id are required')
  }
  const text = extractText(event)
  if (text === undefined) return { kind: 'ignored', reason: 'unsupported' }
  if (!text) return { kind: 'ignored', reason: 'empty' }
  const suppliedName = stringValue(event.sender.name)
  const label = suppliedName ?? `用户 ${shortId(openId)}`
  return { kind: 'message', message: { eventId, messageId, openId, chatId, label, text } }
}
