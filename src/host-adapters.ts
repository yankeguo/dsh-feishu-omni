import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import { CREDENTIAL_REF, type SessionOption } from './public.ts'
import type {
  AttachmentPort, CredentialPort, FileUploadPort, PromptInput, SessionPort, StagedUpload,
} from './types.ts'

/** Raw DSH upload service face (typed structurally to avoid a hard optional dependency). */
interface FileUploadsService {
  uploadImageStream(request: {
    readonly sessionId: unknown
    readonly data: AsyncIterable<Uint8Array>
    readonly mediaType: string
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<{ readonly receiptId: unknown; readonly image?: unknown }>
  uploadStream(request: {
    readonly sessionId: unknown
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<{ readonly receiptId: unknown }>
}

/** Raw DSH attachment service face used for outbound image normalization. */
interface AttachmentsService {
  saveImage(input: {
    readonly data: Uint8Array
    readonly mediaType: string
    readonly name?: string
  }): Promise<unknown>
  readImage(ref: unknown, signal?: AbortSignal): Promise<{ readonly data: Uint8Array }>
}

/** Read one optional Host service without failing plugin activation. */
function optionalService<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

export class DshCredentialPort implements CredentialPort {
  private readonly ref = credentialRef(CREDENTIAL_REF)

  constructor(private readonly ctx: Context) {}

  async set(secret: string): Promise<void> {
    await this.ctx.credentials.set(this.ref, secret)
  }

  async resolve(): Promise<string | undefined> {
    return (await this.ctx.credentials.resolve(this.ref))?.value
  }

  async configured(): Promise<boolean> {
    return (await this.ctx.credentials.describe(this.ref)).configured
  }
}

/**
 * Adapt `ctx.fileUploads` into the plugin's receipt staging port. The service is
 * resolved structurally with `ctx.get` so a Host composition that mounts the
 * Session Controller without attachments (e.g. a stripped test composition)
 * degrades image/file input instead of failing plugin activation.
 */
export class DshFileUploadPort implements FileUploadPort {
  private constructor(private readonly ctx: Context) {}

  static from(ctx: Context): DshFileUploadPort | undefined {
    // Probe once so a missing service degrades input, but resolve at use time so
    // a provider reload (live plugin management) cannot leave a stale instance.
    return optionalService<FileUploadsService>(ctx, 'fileUploads') === undefined
      ? undefined
      : new DshFileUploadPort(ctx)
  }

  private service(): FileUploadsService {
    const service = optionalService<FileUploadsService>(this.ctx, 'fileUploads')
    if (service === undefined) throw new Error('DSH file upload service is unavailable')
    return service
  }

  async uploadImageStream(request: {
    readonly sessionId: string
    readonly data: AsyncIterable<Uint8Array>
    readonly mediaType: string
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<StagedUpload> {
    const result = await this.service().uploadImageStream({
      sessionId: request.sessionId,
      data: request.data,
      mediaType: request.mediaType,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.name === undefined ? {} : { name: request.name }),
    })
    return {
      receiptId: String(result.receiptId),
      ...(result.image === undefined ? {} : { image: result.image }),
    }
  }

  async uploadStream(request: {
    readonly sessionId: string
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<StagedUpload> {
    const result = await this.service().uploadStream({
      sessionId: request.sessionId,
      data: request.data,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.name === undefined ? {} : { name: request.name }),
    })
    return { receiptId: String(result.receiptId) }
  }
}

/** Adapt `ctx.attachments` for outbound image normalization. */
export class DshAttachmentPort implements AttachmentPort {
  private constructor(private readonly ctx: Context) {}

  static from(ctx: Context): DshAttachmentPort | undefined {
    return optionalService<AttachmentsService>(ctx, 'attachments') === undefined
      ? undefined
      : new DshAttachmentPort(ctx)
  }

  private service(): AttachmentsService {
    const service = optionalService<AttachmentsService>(this.ctx, 'attachments')
    if (service === undefined) throw new Error('DSH attachment service is unavailable')
    return service
  }

  saveImage(input: {
    readonly data: Uint8Array
    readonly mediaType: string
    readonly name?: string
  }): Promise<unknown> {
    return this.service().saveImage(input)
  }

  readImage(ref: unknown, signal?: AbortSignal): Promise<{ readonly data: Uint8Array }> {
    return this.service().readImage(ref, signal)
  }
}

export class DshSessionPort implements SessionPort {
  constructor(private readonly ctx: Context) {}

  async list(signal?: AbortSignal): Promise<readonly SessionOption[]> {
    const result = await this.ctx.sessionController.list({}, signal ?? new AbortController().signal)
    return result.items.filter(item => item.origin !== 'subagent').map(item => {
      const projectedTitle = item.projections?.values.title
      return {
        sessionId: item.sessionId,
        title: typeof projectedTitle === 'string' && projectedTitle.trim() ? projectedTitle : item.sessionId,
        cwd: item.cwd ?? null,
        running: item.running,
      }
    })
  }

  async prompt(input: PromptInput, signal?: AbortSignal): Promise<void> {
    const attachments = input.attachments ?? []
    const content: SessionPromptRequest['content'] = attachments.length === 0
      ? [{ type: 'text', text: input.text }]
      : [
          { type: 'text', text: input.text },
          ...attachments.map(attachment => ({
            type: 'file' as const,
            // The receipt is minted by the same DSH composition; the brand is a
            // compile-time marker only.
            receiptId: attachment.receiptId as never,
          })),
        ]
    const request: SessionPromptRequest = {
      requestId: input.requestId as SessionPromptRequest['requestId'],
      sessionId: input.sessionId as SessionPromptRequest['sessionId'],
      mode: 'queue',
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
    const timeout = AbortSignal.timeout(30_000)
    const promptSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    await this.ctx.sessionController.prompt(request, promptSignal)
  }
}
