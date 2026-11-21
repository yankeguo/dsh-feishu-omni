import { describe, expect, it, vi } from 'vitest'
import { OmniBridge } from '../src/bridge.ts'
import { emptyState, MemoryStateStore } from '../src/state.ts'
import type { Binding } from '../src/types.ts'
import { assistantEvent, FakeGateway, FakeSessions, feishuEvent, SESSION, turnEnd, userEvent } from './helpers.ts'

const alice: Binding = { openId: 'ou_alice', chatId: 'oc_alice', label: 'Alice', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
const bob: Binding = { openId: 'ou_bob', chatId: 'oc_bob', label: 'Bob', createdAt: '2026-01-01', updatedAt: '2026-01-01' }

function setup(bindings: readonly Binding[] = []) {
  const state = new MemoryStateStore({ ...emptyState(), sessionId: SESSION.sessionId, bindings })
  const sessions = new FakeSessions()
  const gateway = new FakeGateway()
  const errors: unknown[] = []
  const sleeps: number[] = []
  const bridge = new OmniBridge({
    state, sessions, gateway,
    retry: { attempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    sleep: async milliseconds => { sleeps.push(milliseconds) },
    onError: error => errors.push(error),
  })
  return { state, sessions, gateway, bridge, errors, sleeps }
}

describe('OmniBridge inbound', () => {
  it('binds the sender and submits one attributed prompt to the existing Session', async () => {
    const { bridge, state, sessions } = setup()
    await bridge.receive(feishuEvent({ label: '张三', text: '共享这个任务' }))
    await bridge.drain()
    expect(sessions.prompts).toEqual([{
      sessionId: SESSION.sessionId,
      requestId: 'feishu-omni:om_1',
      text: '[飞书 · 张三]\n共享这个任务',
    }])
    expect(state.snapshot().bindings[0]).toMatchObject({ openId: 'ou_alice', chatId: 'oc_alice', label: '张三' })
    expect(state.snapshot().recentEventIds).toEqual(['message:om_1', 'event:event-1'])
  })

  it('deduplicates by either message_id or event_id across concurrent delivery', async () => {
    const { bridge, sessions } = setup()
    await Promise.all([
      bridge.receive(feishuEvent()),
      bridge.receive(feishuEvent({ eventId: 'event-2' })),
      bridge.receive(feishuEvent({ messageId: 'om_other' })),
    ])
    await bridge.drain()
    expect(sessions.prompts).toHaveLength(1)
  })

  it('does not mark a failed prompt as seen, allowing the same event to recover', async () => {
    const { bridge, sessions, state, gateway, sleeps } = setup()
    let calls = 0
    const attemptedIds: string[] = []
    sessions.promptHook = async input => {
      calls += 1
      attemptedIds.push(input.requestId)
      if (calls <= 3) throw new Error('session unavailable')
      sessions.prompts.push(input)
    }
    await bridge.receive(feishuEvent())
    await bridge.drain()
    expect(state.snapshot().recentEventIds).toEqual([])
    expect(calls).toBe(3)
    expect(sleeps).toEqual([10, 20])
    expect(gateway.sent[0]?.text).toContain('暂时无法投递')
    await bridge.receive(feishuEvent())
    await bridge.drain()
    expect(calls).toBe(4)
    expect(attemptedIds).toEqual(Array(4).fill('feishu-omni:om_1'))
    expect(sessions.prompts).toHaveLength(1)
    expect(state.snapshot().recentEventIds).toContain('message:om_1')
  })

  it('serializes multi-user prompt admission in arrival order', async () => {
    const { bridge, sessions } = setup()
    const order: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    sessions.promptHook = async input => {
      order.push(`start:${input.text}`)
      if (input.requestId.endsWith('om_1')) await gate
      order.push(`end:${input.text}`)
      sessions.prompts.push(input)
    }
    await bridge.receive(feishuEvent({ openId: 'ou_a', chatId: 'oc_a', messageId: 'om_1', eventId: 'e1' }))
    await bridge.receive(feishuEvent({ openId: 'ou_b', chatId: 'oc_b', messageId: 'om_2', eventId: 'e2' }))
    await vi.waitFor(() => expect(order).toHaveLength(1))
    release?.()
    await bridge.drain()
    expect(order.map(row => row.split(':')[0])).toEqual(['start', 'end', 'start', 'end'])
    expect(sessions.prompts.map(input => input.requestId)).toEqual(['feishu-omni:om_1', 'feishu-omni:om_2'])
  })

  it('ignores bot, group and malformed non-user traffic without injecting', async () => {
    const { bridge, sessions } = setup()
    await bridge.receive(feishuEvent({ senderType: 'bot' }))
    await bridge.receive(feishuEvent({ chatType: 'group' }))
    await bridge.receive(feishuEvent({ text: '' }))
    await bridge.drain()
    expect(sessions.prompts).toEqual([])
  })
})

describe('OmniBridge outbound', () => {
  it('broadcasts human input and final assistant replies to every bound user', async () => {
    const { bridge, gateway } = setup([alice, bob])
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, '[飞书 · Alice]\nquestion'))
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(2, 'answer'))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(3))
    await bridge.drain()
    expect(gateway.sent).toHaveLength(4)
    expect(gateway.sent.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob', 'oc_alice', 'oc_bob'])
    expect(gateway.sent[0]?.text).toBe('[飞书 · Alice]\nquestion')
    expect(gateway.sent[2]?.text).toBe('[助手]\nanswer')
    expect(new Set(gateway.sent.map(row => row.uuid)).size).toBe(4)
  })

  it('labels DSH-originated human input and ignores internal, wrong-session and duplicate events', async () => {
    const { bridge, gateway } = setup([alice])
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, 'from GUI', 'web-request'))
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, 'from GUI', 'web-request'))
    await bridge.sessionEvent('another-session', assistantEvent(2))
    await bridge.sessionEvent(SESSION.sessionId, {
      seq: 3, type: 'user/message', surfaceOp: 'append',
      data: { content: [{ type: 'text', text: '[DEV LEAD NOTIFICATION]' }], source: { kind: 'devlead' } },
    })
    await bridge.sessionEvent(SESSION.sessionId, { seq: 4, type: 'tool/result', surfaceOp: 'append', data: {} })
    await bridge.drain()
    expect(gateway.sent).toHaveLength(1)
    expect(gateway.sent[0]?.text).toBe('[DSH]\nfrom GUI')
  })

  it('retries transient failures with the same uuid and isolates terminal recipients', async () => {
    const { bridge, gateway, errors, sleeps } = setup([alice, bob])
    gateway.failures.set('oc_alice', [new Error('timeout'), new Error('timeout')])
    gateway.failures.set('oc_bob', [Object.assign(new Error('bot removed'), { code: 230002 })])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent())
    await bridge.sessionEvent(SESSION.sessionId, turnEnd())
    await bridge.drain()
    expect(gateway.sent.map(row => row.chatId)).toEqual(['oc_alice'])
    expect(gateway.attempts.filter(row => row.chatId === 'oc_alice')).toHaveLength(3)
    expect(new Set(gateway.attempts.filter(row => row.chatId === 'oc_alice').map(row => row.uuid)).size).toBe(1)
    expect(gateway.attempts.filter(row => row.chatId === 'oc_bob')).toHaveLength(1)
    expect(sleeps).toEqual([10, 20])
    expect(errors).toHaveLength(1)
  })

  it('retains a failed binding so a later message can recover after the bot is re-added', async () => {
    const { bridge, gateway, state } = setup([alice])
    gateway.failures.set('oc_alice', [Object.assign(new Error('bot removed'), { response: { status: 403 } })])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'first'))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2))
    await bridge.drain()
    expect(state.snapshot().bindings).toHaveLength(1)
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(4, 'second', 2))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(5, 2))
    await bridge.drain()
    expect(gateway.sent.map(row => row.text)).toEqual(['[助手]\nsecond'])
  })

  it('preserves outbound order while the first recipient write is pending', async () => {
    const { bridge, gateway } = setup([alice])
    const original = gateway.sendText.bind(gateway)
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    gateway.sendText = async (chatId, text, uuid) => {
      calls += 1
      if (calls === 1) await gate
      return original(chatId, text, uuid)
    }
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'first'))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2))
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(3, 'second', 2))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(4, 2))
    await Promise.resolve()
    expect(gateway.sent).toEqual([])
    release?.()
    await bridge.drain()
    expect(gateway.sent.map(row => row.text)).toEqual(['[助手]\nfirst', '[助手]\nsecond'])
  })

  it('broadcasts only the last non-empty assistant message of each completed turn', async () => {
    const { bridge, gateway } = setup([alice])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'working', 7))
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(2, 'final answer', 7))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(3, 7))
    await bridge.drain()
    expect(gateway.sent.map(row => row.text)).toEqual(['[助手]\nfinal answer'])
  })

  it('does not broadcast an interrupted assistant fragment even when the turn completes', async () => {
    const { bridge, gateway } = setup([alice])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'partial answer', 1, true))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2))
    await bridge.drain()
    expect(gateway.sent).toEqual([])
  })

  it.each(['aborted', 'blocked', 'error', 'max-tokens'])('does not broadcast assistant text for a %s turn', async kind => {
    const { bridge, gateway } = setup([alice])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'incomplete answer'))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2, 1, { kind }))
    await bridge.drain()
    expect(gateway.sent).toEqual([])
  })

  it('accepts the string form of a completed turn reason', async () => {
    const { bridge, gateway } = setup([alice])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'complete answer'))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2, 1, 'completed'))
    await bridge.drain()
    expect(gateway.sent.map(row => row.text)).toEqual(['[助手]\ncomplete answer'])
  })

  it('aborts a permanently stalled send so stop and the global queue finish', async () => {
    const { bridge, gateway } = setup([alice])
    let calls = 0
    gateway.sendText = () => {
      calls += 1
      return new Promise<void>(() => {})
    }
    await bridge.sessionEvent(SESSION.sessionId, userEvent())
    await vi.waitFor(() => expect(calls).toBe(1))
    await bridge.stop()
    await bridge.drain()
    expect(gateway.stops).toBe(1)
  })

  it('does not broadcast empty assistant content or streaming attempts', async () => {
    const { bridge, gateway } = setup([alice])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, ''))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2))
    await bridge.sessionEvent(SESSION.sessionId, { seq: 3, type: 'assistant/attempt', data: { stream: [] } })
    await bridge.drain()
    expect(gateway.sent).toEqual([])
  })
})
