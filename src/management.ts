import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { OmniController } from './controller.ts'
import { safeMessage } from './errors.ts'
import { RPC_ENDPOINT, type ConfigureInput, type ManagementMethod, type ManagementResult } from './public.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function reply(rpcId: string, result: ManagementResult): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

function ok(value: unknown): ManagementResult {
  return { ok: true, value }
}

function failure(error: unknown): ManagementResult {
  const code = typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'feishu-omni/request-failed'
  return { ok: false, error: { code, message: safeMessage(error), details: {} } }
}

function configureInput(value: unknown): ConfigureInput {
  const input = record(value)
  if (input === undefined || typeof input.appId !== 'string' || typeof input.sessionId !== 'string'
    || (input.appSecret !== undefined && typeof input.appSecret !== 'string')) {
    throw new Error('configure requires appId, sessionId and an optional appSecret string')
  }
  return {
    appId: input.appId,
    sessionId: input.sessionId,
    ...(input.appSecret === undefined ? {} : { appSecret: input.appSecret }),
  }
}

export async function dispatchManagement(
  controller: OmniController,
  method: ManagementMethod | string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<ManagementResult> {
  try {
    switch (method) {
      case 'status': return ok(await controller.status())
      case 'sessions.list': return ok(await controller.listSessions(signal))
      case 'configure': return ok(await controller.configure(configureInput(payload)))
      case 'connect': return ok(await controller.connect())
      case 'disconnect': return ok(await controller.disconnect())
      case 'test': return ok(await controller.sendTest())
      default: return { ok: false, error: { code: 'gateway/bad-request', message: 'Unknown Feishu Omni method', details: {} } }
    }
  } catch (error) {
    return failure(error)
  }
}

/** Mount one small JSON RPC on DSH's existing authenticated /api carrier. */
export function registerManagementRoute(ctx: Context, controller: OmniController): () => void {
  return ctx.connection.fetch.register({
    path: `/api/${RPC_ENDPOINT}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let message: unknown
      try { message = await request.json() } catch { return new Response('body is not JSON', { status: 400 }) }
      const envelope = record(message)
      const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'invalid-request'
      const call = record(envelope?.payload)
      if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string'
        || envelope.method !== RPC_ENDPOINT || call === undefined || typeof call.method !== 'string'
        || !Object.hasOwn(call, 'payload')) {
        return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid management request', details: {} } })
      }
      const result = await dispatchManagement(controller, call.method, call.payload, request.signal)
      return reply(rpcId, result)
    },
  })
}
