import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import { CREDENTIAL_REF, type SessionOption } from './public.ts'
import type { CredentialPort, PromptInput, SessionPort } from './types.ts'

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
    const request: SessionPromptRequest = {
      requestId: input.requestId as SessionPromptRequest['requestId'],
      sessionId: input.sessionId as SessionPromptRequest['sessionId'],
      mode: 'queue',
      content: [{ type: 'text', text: input.text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
    const timeout = AbortSignal.timeout(30_000)
    const promptSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    await this.ctx.sessionController.prompt(request, promptSignal)
  }
}
