/**
 * Dependency-free helpers for the Feishu image/file bridge.
 *
 * Feishu accepts exactly four raster image formats (`png`, `jpeg`, `webp`,
 * `gif`) and its upload APIs cap images at 10 MiB and files at 30 MiB. The DSH
 * attachment service accepts the same four image media types. Everything here
 * is pure so both the inbound (download/stage) and outbound (present/inline)
 * paths share one format decision.
 */

/** Official Feishu image upload limit: 10 MiB per image. */
export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** Official Feishu file upload limit: 30 MiB per file. */
export const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024

/**
 * Bound applied while downloading an inbound image. Deliberately below the DSH
 * default image limit (50 MiB) so a pathological image cannot hold the FIFO.
 */
export const INBOUND_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** Feishu resource download limit for `type=file`; larger resources need Range, which this plugin does not use. */
export const INBOUND_FILE_MAX_BYTES = 100 * 1024 * 1024

/** Image media types accepted by both DSH attachments and Feishu uploads. */
export type SupportedImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Why one inbound/outbound attachment could not be bridged. */
export type AttachmentFailureReason =
  /** Exceeded this plugin's or the platform's byte bound. */
  | 'too-large'
  /** DSH refused the image for its deployment-specific byte limit. */
  | 'image-bytes'
  /** DSH refused the image for its pixel-count or single-edge limit. */
  | 'image-pixels'
  /** The resource download failed or delivered no bytes. */
  | 'download'
  /** A Feishu upload did not return a usable key. */
  | 'upload'
  /** A recognized image container outside the four formats DSH accepts. */
  | 'unsupported-image'
  /** The image bytes are corrupt, truncated, or lie about their media type. */
  | 'invalid-image'
  /** One Feishu message carried more attachments than this bridge accepts. */
  | 'too-many'
  /** DSH refused the batch for its configured images-per-message limit. */
  | 'too-many-images'

/** Typed attachment failure so the bridge can pick a specific degradation notice. */
export class AttachmentFailure extends Error {
  /** Optional machine detail, e.g. the recognized unsupported image format. */
  readonly detail: string | undefined

  constructor(
    message: string,
    readonly reason: AttachmentFailureReason,
    options: ErrorOptions & { readonly detail?: string } = {},
  ) {
    super(message, options)
    this.name = 'AttachmentFailure'
    this.detail = options.detail
  }
}

/** Recognized-but-unsupported image containers, used for a specific degradation message. */
export type UnsupportedImageFormat = 'heic' | 'bmp' | 'tiff' | 'svg'

/** Feishu `file_type` values accepted by `POST /open-apis/im/v1/files`. */
export type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.byteLength < offset + expected.length) return false
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false
  }
  return true
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false
  }
  return true
}

/**
 * Detect one of the four supported raster formats from the leading bytes. The
 * caller must supply at least 16 bytes when available; shorter resources
 * simply fail detection.
 */
export function imageMediaType(head: Uint8Array): SupportedImageMediaType | undefined {
  if (startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWithBytes(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (asciiAt(head, 0, 'GIF87a') || asciiAt(head, 0, 'GIF89a')) return 'image/gif'
  if (asciiAt(head, 0, 'RIFF') && asciiAt(head, 8, 'WEBP')) return 'image/webp'
  return undefined
}

/**
 * Name a recognized-but-unsupported image container so the sender receives a
 * specific degradation message instead of a generic failure.
 */
export function unsupportedImageFormat(head: Uint8Array): UnsupportedImageFormat | undefined {
  if (asciiAt(head, 4, 'ftyp') && (asciiAt(head, 8, 'heic') || asciiAt(head, 8, 'heix')
    || asciiAt(head, 8, 'hevc') || asciiAt(head, 8, 'hevx')
    || asciiAt(head, 8, 'mif1') || asciiAt(head, 8, 'msf1'))) return 'heic'
  if (asciiAt(head, 0, 'BM')) return 'bmp'
  if (startsWithBytes(head, [0x49, 0x49, 0x2a, 0x00]) || startsWithBytes(head, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff'
  // SVG is text; tolerate a BOM/XML prologue inside the sniffed head.
  const text = new TextDecoder().decode(head).toLowerCase()
  if (text.includes('<svg')) return 'svg'
  return undefined
}

/** File extension for a supported media type, used in display names only. */
export function mediaTypeExtension(mediaType: SupportedImageMediaType): 'png' | 'jpeg' | 'webp' | 'gif' {
  return mediaType.slice('image/'.length) as 'png' | 'jpeg' | 'webp' | 'gif'
}

function extensionOf(name: string): string {
  const normalized = name.trim().toLowerCase()
  const separator = normalized.lastIndexOf('.')
  return separator < 0 ? '' : normalized.slice(separator + 1)
}

/**
 * Map a file name to the Feishu `file_type` used with `msg_type=file`.
 *
 * Audio/video are deliberately uploaded as `stream` instead of `opus`/`mp4`:
 * Feishu rejects a `msg_type=file` message whose uploaded `file_type` is
 * `opus`/`mp4` (business code 230055, because those must be sent as
 * `msg_type=audio`/`media`). The docs pair `stream` with `msg_type=file` as the
 * fallback for anything outside the document enum, but whether Feishu
 * content-sniffs audio/video bytes uploaded as `stream` is not documented and
 * must be verified against a real tenant.
 */
export function feishuFileType(name: string): FeishuFileType {
  switch (extensionOf(name)) {
    case 'pdf':
      return 'pdf'
    case 'doc':
    case 'docx':
    case 'wps':
      return 'doc'
    case 'xls':
    case 'xlsx':
    case 'csv':
      return 'xls'
    case 'ppt':
    case 'pptx':
      return 'ppt'
    default:
      return 'stream'
  }
}

/** Human-readable byte count used in degradation notices. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** Concatenate ordered byte chunks into one buffer. */
export function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Read a whole byte iterable while refusing to exceed `maxBytes`. Used for
 * inbound images, which must be sniffed before they may be staged.
 */
export async function readAllBounded(
  data: AsyncIterable<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of data) {
    total += chunk.byteLength
    if (total > maxBytes) {
      throw new AttachmentFailure(`Feishu ${label} download exceeded the ${maxBytes} byte limit`, 'too-large')
    }
    chunks.push(chunk)
  }
  return concatBytes(chunks, total)
}

/** A streamed source that counts bytes, enforces a hard cap, and keeps a bounded copy. */
export interface CollectedStream {
  /** Forwarded bytes; single use, exactly once. */
  readonly data: AsyncIterable<Uint8Array>
  /** Buffered copy when the whole stream stayed within `collectBytes`, else `undefined`. */
  collected(): Uint8Array | undefined
}

/**
 * Enforce the inbound byte cap while streaming into the DSH attachment service
 * and remember at most `collectBytes` for a later Feishu re-upload. The copy is
 * discarded as soon as the stream proves larger, so a 100 MB download never
 * doubles into a 100 MB in-memory file.
 */
export function collectingStream(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  collectBytes: number,
  label: string,
): CollectedStream {
  const chunks: Uint8Array[] = []
  let total = 0
  let overflow = false
  const data = (async function* forward(): AsyncIterable<Uint8Array> {
    for await (const chunk of source) {
      total += chunk.byteLength
      if (total > maxBytes) {
        throw new AttachmentFailure(`Feishu ${label} download exceeded the ${maxBytes} byte limit`, 'too-large')
      }
      if (!overflow) {
        if (total <= collectBytes) chunks.push(chunk)
        else {
          overflow = true
          chunks.length = 0
        }
      }
      yield chunk
    }
  })()
  return {
    data,
    collected: () => (overflow || chunks.length === 0 ? undefined : concatBytes(chunks, total)),
  }
}

