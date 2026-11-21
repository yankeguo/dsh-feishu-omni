import type { Context } from '@deepseek-ai/cordis'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import { describe, expect, it, vi } from 'vitest'
import { DshSessionPort } from '../src/host-adapters.ts'

describe('DshSessionPort', () => {
  it('lists ordinary Sessions with display titles and submits queue prompts with request identity', async () => {
    const prompt = vi.fn(async (_request: SessionPromptRequest, _signal: AbortSignal) => ({ accepted: true as const }))
    const ctx = {
      sessionController: {
        list: async () => ({
          items: [
            { sessionId: 'session-a', running: true, cwd: '/work/a', projections: { values: { title: 'Lead' } } },
            { sessionId: 'session-child', running: false, origin: 'subagent', projections: { values: {} } },
          ],
        }),
        prompt,
      },
    } as unknown as Context
    const port = new DshSessionPort(ctx)
    expect(await port.list()).toEqual([{ sessionId: 'session-a', title: 'Lead', cwd: '/work/a', running: true }])
    await port.prompt({ sessionId: 'session-a', requestId: 'feishu-omni:om_1', text: '[飞书 · Alice]\nhello' })
    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-a', requestId: 'feishu-omni:om_1', mode: 'queue',
      content: [{ type: 'text', text: '[飞书 · Alice]\nhello' }],
    })
  })
})
