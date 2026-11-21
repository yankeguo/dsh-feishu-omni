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

/**
 * Resource namespace of one inbound attachment: images download through the
 * `image` resource type, everything else through `file`.
 */
export type InboundAttachmentType = 'image' | 'file'

/** Originating Feishu message type; only used for the human-facing placeholder. */
export type InboundAttachmentKind = 'image' | 'file' | 'audio' | 'media'

/** One image/file resource referenced by an inbound Feishu message. */
export interface InboundAttachment {
  readonly type: InboundAttachmentType
  readonly kind: InboundAttachmentKind
  /** Resource key: `image_key` for images and `file_key` for file-like messages. */
  readonly key: string
  /** Declared display name; only used for display and the Feishu upload, never as a path. */
  readonly name?: string
}

export interface InboundMessage {
  readonly eventId: string
  readonly messageId: string
  readonly openId: string
  readonly chatId: string
  readonly label: string
  readonly text: string
  readonly attachments: readonly InboundAttachment[]
}

export type EventExtraction =
  | { readonly kind: 'message'; readonly message: InboundMessage }
  | {
    readonly kind: 'ignored'
    readonly reason: 'bot' | 'group' | 'unsupported' | 'empty'
  }

interface ExtractedBody {
  readonly text: string
  readonly attachments: readonly InboundAttachment[]
}

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

/** Post rich-text `img`/`media` nodes carry resources beside the text body. */
function postAttachments(content: Record<string, unknown>): InboundAttachment[] {
  if (!Array.isArray(content.content)) return []
  const attachments: InboundAttachment[] = []
  const seen = new Set<string>()
  for (const paragraph of content.content) {
    if (!Array.isArray(paragraph)) continue
    for (const node of paragraph) {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) continue
      const element = node as Record<string, unknown>
      if (element.tag !== 'img') continue
      const key = stringValue(element.image_key)
      if (key === undefined || seen.has(key)) continue
      seen.add(key)
      attachments.push({ type: 'image', kind: 'image', key })
    }
  }
  return attachments
}

function postText(content: Record<string, unknown>, event: FeishuMessageEvent): string {
  const lines: string[] = []
  if (typeof content.title === 'string' && content.title.trim()) lines.push(content.title.trim())
  if (!Array.isArray(content.content)) return lines.join('\n')
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

/**
 * Extract the prompt body of one message. Supported non-text message types are
 * rejected as `undefined` (unsupported) when the resource key is missing, so a
 * malformed payload can never reach prompt admission with an empty message.
 */
function extractBody(event: FeishuMessageEvent): ExtractedBody | undefined {
  const content = contentRecord(event.message?.content)
  if (content === undefined) return undefined
  switch (event.message?.message_type) {
    case 'text':
      return {
        text: typeof content.text === 'string' ? withoutMentions(content.text, event) : '',
        attachments: [],
      }
    case 'post':
      return { text: postText(content, event), attachments: postAttachments(content) }
    case 'image': {
      const key = stringValue(content.image_key)
      if (key === undefined) return undefined
      return { text: '', attachments: [{ type: 'image', kind: 'image', key }] }
    }
    case 'file': {
      const key = stringValue(content.file_key)
      if (key === undefined) return undefined
      const name = stringValue(content.file_name)
      return {
        text: '',
        attachments: [{ type: 'file', kind: 'file', key, ...(name === undefined ? {} : { name }) }],
      }
    }
    case 'audio': {
      const key = stringValue(content.file_key)
      if (key === undefined) return undefined
      return { text: '', attachments: [{ type: 'file', kind: 'audio', key }] }
    }
    case 'media': {
      const key = stringValue(content.file_key)
      if (key === undefined) return undefined
      const name = stringValue(content.file_name)
      return {
        text: '',
        attachments: [{ type: 'file', kind: 'media', key, ...(name === undefined ? {} : { name }) }],
      }
    }
    default:
      return undefined
  }
}

function shortId(openId: string): string {
  if (openId.length <= 12) return openId
  return `${openId.slice(0, 6)}…${openId.slice(-4)}`
}

/**
 * Accepts direct user messages from a p2p chat only: text/post with optional
 * images, plus image/file/audio/media attachments. Rejecting bot and group
 * events here is the first anti-echo boundary and deliberately keeps group
 * fan-out out of the shared-session security model.
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
  const body = extractBody(event)
  if (body === undefined) return { kind: 'ignored', reason: 'unsupported' }
  if (!body.text && body.attachments.length === 0) return { kind: 'ignored', reason: 'empty' }
  const suppliedName = stringValue(event.sender.name)
  const label = suppliedName ?? `用户 ${shortId(openId)}`
  return {
    kind: 'message',
    message: {
      eventId, messageId, openId, chatId, label,
      text: body.text,
      attachments: body.attachments,
    },
  }
}
