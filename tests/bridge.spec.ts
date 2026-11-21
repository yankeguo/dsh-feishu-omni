import { describe, expect, it, vi } from 'vitest'
import { ACK_EMOJI, OmniBridge } from '../src/bridge.ts'
import {
  assistantCardTitle, buildAssistantCard, CARD_REQUEST_MAX_BYTES, estimateCardRequestBytes, splitAssistantMarkdown,
} from '../src/card.ts'
import { emptyState, MemoryStateStore } from '../src/state.ts'
import type { Binding } from '../src/types.ts'
import { assistantEvent, FakeGateway, FakeSessions, feishuEvent, SESSION, turnEnd, userEvent } from './helpers.ts'

const alice: Binding = { openId: 'ou_alice', chatId: 'oc_alice', label: 'Alice', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
const bob: Binding = { openId: 'ou_bob', chatId: 'oc_bob', label: 'Bob', createdAt: '2026-01-01', updatedAt: '2026-01-01' }

interface CapturedLog {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
}

function setup(bindings: readonly Binding[] = [], options: { ackTimeoutMs?: number } = {}) {
  const state = new MemoryStateStore({ ...emptyState(), sessionId: SESSION.sessionId, bindings })
  const sessions = new FakeSessions()
  const gateway = new FakeGateway()
  const errors: unknown[] = []
  const sleeps: number[] = []
  const logs: CapturedLog[] = []
  const logger = {
    info: (message: string) => { logs.push({ level: 'info', message }) },
    warn: (message: string) => { logs.push({ level: 'warn', message }) },
    error: (message: string) => { logs.push({ level: 'error', message }) },
  }
  const bridge = new OmniBridge({
    state, sessions, gateway, logger,
    retry: { attempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    sleep: async milliseconds => { sleeps.push(milliseconds) },
    onError: error => errors.push(error),
    ...(options.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: options.ackTimeoutMs }),
  })
  return { state, sessions, gateway, bridge, errors, sleeps, logs }
}

describe('OmniBridge inbound', () => {
  it('binds the sender and submits one attributed prompt to the existing Session', async () => {
    const { bridge, state, sessions, gateway } = setup()
    await bridge.receive(feishuEvent({ label: '张三', text: '共享这个任务' }))
    await bridge.drain()
    expect(sessions.prompts).toEqual([{
      sessionId: SESSION.sessionId,
      requestId: 'feishu-omni:om_1:oc_alice',
      text: '[飞书 · 张三]\n共享这个任务',
    }])
    expect(state.snapshot().bindings[0]).toMatchObject({ openId: 'ou_alice', chatId: 'oc_alice', label: '张三' })
    expect(state.snapshot().recentEventIds).toEqual(['message:om_1', 'event:event-1'])
    // Admission succeeded: acknowledge the original message exactly once.
    expect(gateway.reactionAttempts).toEqual([{ messageId: 'om_1', emojiType: ACK_EMOJI }])
    expect(ACK_EMOJI).toBe('OK')
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
    // A failed admission is not acknowledged; the ack arrives with the recovery.
    expect(gateway.reactionAttempts).toEqual([])
    await bridge.receive(feishuEvent())
    await bridge.drain()
    expect(calls).toBe(4)
    expect(attemptedIds).toEqual(Array(4).fill('feishu-omni:om_1:oc_alice'))
    expect(sessions.prompts).toHaveLength(1)
    expect(state.snapshot().recentEventIds).toContain('message:om_1')
    expect(gateway.reactionAttempts).toEqual([{ messageId: 'om_1', emojiType: ACK_EMOJI }])
  })

  it('serializes multi-user prompt admission in arrival order', async () => {
    const { bridge, sessions } = setup()
    const order: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    sessions.promptHook = async input => {
      order.push(`start:${input.text}`)
      if (input.requestId.startsWith('feishu-omni:om_1:')) await gate
      order.push(`end:${input.text}`)
      sessions.prompts.push(input)
    }
    await bridge.receive(feishuEvent({ openId: 'ou_a', chatId: 'oc_a', messageId: 'om_1', eventId: 'e1' }))
    await bridge.receive(feishuEvent({ openId: 'ou_b', chatId: 'oc_b', messageId: 'om_2', eventId: 'e2' }))
    await vi.waitFor(() => expect(order).toHaveLength(1))
    release?.()
    await bridge.drain()
    expect(order.map(row => row.split(':')[0])).toEqual(['start', 'end', 'start', 'end'])
    expect(sessions.prompts.map(input => input.requestId)).toEqual(['feishu-omni:om_1:oc_a', 'feishu-omni:om_2:oc_b'])
  })

  it('ignores bot, group and malformed non-user traffic without injecting', async () => {
    const { bridge, sessions, gateway } = setup()
    await bridge.receive(feishuEvent({ senderType: 'bot' }))
    await bridge.receive(feishuEvent({ chatType: 'group' }))
    await bridge.receive(feishuEvent({ text: '' }))
    await bridge.drain()
    expect(sessions.prompts).toEqual([])
    expect(gateway.reactionAttempts).toEqual([])
  })
})

describe('OmniBridge outbound', () => {
  it('broadcasts human input to every binding except the sender and final replies to everyone', async () => {
    const { bridge, gateway } = setup([alice, bob])
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, '[飞书 · Alice]\nquestion', 'feishu-omni:om_1:oc_alice'))
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(2, 'answer'))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(3))
    await bridge.drain()
    expect(gateway.sent.map(row => row.chatId)).toEqual(['oc_bob'])
    expect(gateway.sent[0]?.text).toBe('[飞书 · Alice]\nquestion')
    expect(gateway.cards.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob'])
    expect(gateway.cards.map(row => row.markdown)).toEqual(['answer', 'answer'])
    expect(gateway.cards.map(row => row.title)).toEqual(['[助手]', '[助手]'])
    const uuids = [...gateway.sent, ...gateway.cards].map(row => row.uuid)
    expect(new Set(uuids).size).toBe(3)
    for (const uuid of uuids) expect(uuid.length).toBeLessThanOrEqual(50)
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

  it('retries transient card failures with the same uuid and isolates permanent recipients', async () => {
    const { bridge, gateway, errors, sleeps } = setup([alice, bob])
    gateway.cardFailures.set('oc_alice', [new Error('timeout'), new Error('timeout')])
    gateway.cardFailures.set('oc_bob', [Object.assign(new Error('bot removed'), { code: 230002 })])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent())
    await bridge.sessionEvent(SESSION.sessionId, turnEnd())
    await bridge.drain()
    expect(gateway.cards.map(row => row.chatId)).toEqual(['oc_alice'])
    expect(gateway.sent).toEqual([])
    expect(gateway.cardAttempts.filter(row => row.chatId === 'oc_alice')).toHaveLength(3)
    expect(new Set(gateway.cardAttempts.filter(row => row.chatId === 'oc_alice').map(row => row.uuid)).size).toBe(1)
    expect(gateway.cardAttempts.filter(row => row.chatId === 'oc_bob')).toHaveLength(1)
    expect(sleeps).toEqual([10, 20])
    expect(errors).toHaveLength(1)
  })

  it('retains a failed binding so a later message can recover after the bot is re-added', async () => {
    const { bridge, gateway, state, errors } = setup([alice])
    const forbidden = (): Error => Object.assign(new Error('bot removed'), { response: { status: 403 } })
    gateway.cardFailures.set('oc_alice', [forbidden()])
    gateway.failures.set('oc_alice', [forbidden()])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'first'))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2))
    await bridge.drain()
    expect(state.snapshot().bindings).toHaveLength(1)
    // The rejected card falls back to text, but the recipient still rejects it.
    expect(gateway.cardAttempts).toHaveLength(1)
    expect(gateway.sent).toEqual([])
    expect(errors).toHaveLength(1)
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(4, 'second', 2))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(5, 2))
    await bridge.drain()
    expect(gateway.cards.map(row => row.markdown)).toEqual(['second'])
  })

  it('preserves outbound order while the first recipient card write is pending', async () => {
    const { bridge, gateway } = setup([alice])
    const original = gateway.sendMarkdown.bind(gateway)
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    gateway.sendMarkdown = async (chatId, markdown, uuid, signal, options) => {
      calls += 1
      if (calls === 1) await gate
      return original(chatId, markdown, uuid, signal, options)
    }
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'first'))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2))
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(3, 'second', 2))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(4, 2))
    await Promise.resolve()
    expect(gateway.cards).toEqual([])
    release?.()
    await bridge.drain()
    expect(gateway.cards.map(row => row.markdown)).toEqual(['first', 'second'])
  })

  it('broadcasts only the last non-empty assistant message of each completed turn', async () => {
    const { bridge, gateway } = setup([alice])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'working', 7))
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(2, 'final answer', 7))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(3, 7))
    await bridge.drain()
    expect(gateway.cards.map(row => row.markdown)).toEqual(['final answer'])
  })

  it('does not broadcast an interrupted assistant fragment even when the turn completes', async () => {
    const { bridge, gateway } = setup([alice])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'partial answer', 1, true))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2))
    await bridge.drain()
    expect(gateway.cards).toEqual([])
    expect(gateway.sent).toEqual([])
  })

  it.each(['aborted', 'blocked', 'error', 'max-tokens'])('does not broadcast assistant text for a %s turn', async kind => {
    const { bridge, gateway } = setup([alice])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'incomplete answer'))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2, 1, { kind }))
    await bridge.drain()
    expect(gateway.cards).toEqual([])
    expect(gateway.sent).toEqual([])
  })

  it('accepts the string form of a completed turn reason', async () => {
    const { bridge, gateway } = setup([alice])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'complete answer'))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2, 1, 'completed'))
    await bridge.drain()
    expect(gateway.cards.map(row => row.markdown)).toEqual(['complete answer'])
  })

  it('aborts a permanently stalled send so stop and the global queue finish', async () => {
    // The sender's own chat is excluded, so the mirror goes to Bob.
    const { bridge, gateway } = setup([alice, bob])
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
    expect(gateway.cards).toEqual([])
    expect(gateway.sent).toEqual([])
  })
})

describe('OmniBridge echo suppression', () => {
  const mirrored = (rows: readonly { chatId: string; text: string }[]) => rows.map(row => ({ chatId: row.chatId, text: row.text }))

  it('does not mirror a Feishu message back to its sender but mirrors it to every other binding', async () => {
    const { bridge, gateway } = setup([alice, bob])
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, '[飞书 · Alice]\nquestion', 'feishu-omni:om_1:oc_alice'))
    await bridge.drain()
    expect(mirrored(gateway.sent)).toEqual([{ chatId: 'oc_bob', text: '[飞书 · Alice]\nquestion' }])
  })

  it('applies the same rule in the other direction', async () => {
    const { bridge, gateway } = setup([alice, bob])
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, '[飞书 · Bob]\nreply', 'feishu-omni:om_2:oc_bob'))
    await bridge.drain()
    expect(mirrored(gateway.sent)).toEqual([{ chatId: 'oc_alice', text: '[飞书 · Bob]\nreply' }])
  })

  it('mirrors to multiple bindings while still excluding the sender', async () => {
    const carol: Binding = { openId: 'ou_carol', chatId: 'oc_carol', label: 'Carol', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
    const { bridge, gateway } = setup([alice, bob, carol])
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, '[飞书 · Bob]\nhi', 'feishu-omni:om_2:oc_bob'))
    await bridge.drain()
    expect(gateway.sent.map(row => row.chatId)).toEqual(['oc_alice', 'oc_carol'])
  })

  it('still broadcasts DSH web human input to every binding', async () => {
    const { bridge, gateway } = setup([alice, bob])
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, 'from GUI', 'web-request'))
    // A human message without a usable rpcId (other DSH clients) is still [DSH].
    await bridge.sessionEvent(SESSION.sessionId, {
      seq: 2, type: 'user/message', surfaceOp: 'append',
      data: { content: [{ type: 'text', text: 'no rpc id' }], source: { kind: 'user' } },
    })
    await bridge.sessionEvent(SESSION.sessionId, {
      seq: 3, type: 'user/message', surfaceOp: 'append',
      data: { content: [{ type: 'text', text: 'odd rpc id' }], source: { kind: 'user', rpcId: 42 } },
    })
    await bridge.drain()
    expect(gateway.sent.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob', 'oc_alice', 'oc_bob', 'oc_alice', 'oc_bob'])
    expect(gateway.sent.map(row => row.text)).toEqual([
      '[DSH]\nfrom GUI', '[DSH]\nfrom GUI',
      '[DSH]\nno rpc id', '[DSH]\nno rpc id',
      '[DSH]\nodd rpc id', '[DSH]\nodd rpc id',
    ])
  })

  it('keeps broadcasting to everyone when a legacy rpcId has no chat tail', async () => {
    const { bridge, gateway } = setup([alice, bob])
    // Messages submitted by a pre-upgrade plugin version carry no chat id.
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, '[飞书 · Alice]\nlegacy', 'feishu-omni:om_1'))
    await bridge.drain()
    expect(gateway.sent.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob'])
    expect(gateway.sent[0]?.text).toBe('[飞书 · Alice]\nlegacy')
  })

  it('keeps broadcasting to everyone when the rpcId tail is malformed', async () => {
    const { bridge, gateway } = setup([alice, bob])
    const rpcIds = ['feishu-omni:', 'feishu-omni::oc_alice', 'feishu-omni:om_1:']
    for (const [index, rpcId] of rpcIds.entries()) {
      await bridge.sessionEvent(SESSION.sessionId, userEvent(index + 1, '[飞书 · Alice]\nmalformed', rpcId))
    }
    await bridge.drain()
    expect(gateway.sent.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob', 'oc_alice', 'oc_bob', 'oc_alice', 'oc_bob'])
  })

  it('keeps broadcasting to everyone when the decoded chat is not a current binding', async () => {
    const { bridge, gateway } = setup([alice, bob])
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, '[飞书 · Alice]\nstale', 'feishu-omni:om_1:oc_removed'))
    await bridge.drain()
    expect(gateway.sent.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob'])
  })
})

describe('OmniBridge reaction ack', () => {
  it('acknowledges the original message once after prompt admission', async () => {
    const { bridge, gateway, logs } = setup()
    await bridge.receive(feishuEvent())
    await bridge.drain()
    expect(gateway.reactionAttempts).toEqual([{ messageId: 'om_1', emojiType: 'OK' }])
    expect(gateway.reactions).toEqual([{ messageId: 'om_1', emojiType: ACK_EMOJI }])
    expect(logs.filter(log => log.level === 'warn')).toEqual([])
  })

  it('never reacts twice when Feishu redelivers the same message', async () => {
    const { bridge, gateway, sessions } = setup()
    await bridge.receive(feishuEvent())
    await bridge.receive(feishuEvent())
    await bridge.receive(feishuEvent({ eventId: 'event-2' }))
    await bridge.drain()
    expect(sessions.prompts).toHaveLength(1)
    expect(gateway.reactionAttempts).toHaveLength(1)
  })

  it('does not react to ignored traffic', async () => {
    const { bridge, gateway } = setup()
    await bridge.receive(feishuEvent({ senderType: 'bot' }))
    await bridge.receive(feishuEvent({ chatType: 'group' }))
    await bridge.receive(feishuEvent({ text: '' }))
    await bridge.drain()
    expect(gateway.reactionAttempts).toEqual([])
  })

  it('keeps prompt admission and broadcast working when the ack lacks permission, logging once', async () => {
    const { bridge, sessions, gateway, state, errors, logs } = setup([alice, bob])
    const missingScope = () => Object.assign(new Error('Access denied: scope required'), { code: 99991672 })
    gateway.reactionFailures.push(missingScope(), missingScope())
    await bridge.receive(feishuEvent())
    await bridge.receive(feishuEvent({ messageId: 'om_2', eventId: 'event-2' }))
    await bridge.drain()
    // Admission, dedupe state and broadcast are untouched by ack failures.
    expect(sessions.prompts).toHaveLength(2)
    expect(state.snapshot().recentEventIds).toContain('message:om_1')
    expect(state.snapshot().recentEventIds).toContain('message:om_2')
    expect(gateway.reactions).toEqual([])
    // No retry: one attempt per accepted message.
    expect(gateway.reactionAttempts).toHaveLength(2)
    expect(errors).toEqual([])
    const warnings = logs.filter(log => log.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('im:message.reactions:write_only')
    expect(warnings[0]?.message).toContain('code=99991672')
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, '[飞书 · Alice]\nhello', 'feishu-omni:om_1:oc_alice'))
    await bridge.drain()
    expect(gateway.sent.map(row => row.chatId)).toEqual(['oc_bob'])
  })

  it('logs one recovery message after the ack starts succeeding again', async () => {
    const { bridge, gateway, logs } = setup()
    gateway.reactionFailures.push(Object.assign(new Error('rate limited'), { code: 99991400 }))
    await bridge.receive(feishuEvent())
    await bridge.drain()
    await bridge.receive(feishuEvent({ messageId: 'om_2', eventId: 'event-2' }))
    await bridge.drain()
    expect(gateway.reactions).toEqual([{ messageId: 'om_2', emojiType: ACK_EMOJI }])
    expect(logs.filter(log => log.level === 'warn')).toHaveLength(1)
    expect(logs.filter(log => log.level === 'info' && log.message.includes('recovered'))).toHaveLength(1)
  })

  it('bounds a stalled acknowledgement so later inbound work still runs', async () => {
    const { bridge, gateway, logs } = setup([], { ackTimeoutMs: 20 })
    let calls = 0
    let signal: AbortSignal | undefined
    gateway.addReaction = (_messageId: string, _emojiType: string, reactionSignal?: AbortSignal) => {
      calls += 1
      signal = reactionSignal
      return new Promise<void>(() => {})
    }
    await bridge.receive(feishuEvent())
    await bridge.drain()
    expect(calls).toBe(1)
    // The ack signal is bounded too, so the in-flight request is cancelled.
    expect(signal?.aborted).toBe(true)
    await bridge.receive(feishuEvent({ messageId: 'om_2', eventId: 'event-2' }))
    await bridge.drain()
    expect(calls).toBe(2)
    // The same 'other' failure state is logged only once.
    expect(logs.filter(log => log.level === 'warn')).toHaveLength(1)
  })

  it('persists the dedupe keys before acknowledging', async () => {
    const { bridge, gateway, state } = setup()
    let updates = 0
    const original = state.update.bind(state)
    state.update = async mutator => {
      updates += 1
      // update #1 saves the binding, update #2 persists the dedupe keys.
      if (updates === 2) throw new Error('state write failed')
      return original(mutator)
    }
    await bridge.receive(feishuEvent())
    await bridge.drain()
    expect(updates).toBe(2)
    // A failed dedupe write must not acknowledge; a redelivery may retry.
    expect(gateway.reactionAttempts).toEqual([])
  })

  it('logs a new warning when the ack failure kind changes', async () => {
    const { bridge, gateway, logs } = setup()
    gateway.reactionFailures.push(Object.assign(new Error('missing scope'), { code: 99991672 }))
    gateway.reactionFailures.push(Object.assign(new Error('too many requests'), { code: 99991400 }))
    await bridge.receive(feishuEvent())
    await bridge.drain()
    await bridge.receive(feishuEvent({ messageId: 'om_2', eventId: 'event-2' }))
    await bridge.drain()
    const warnings = logs.filter(log => log.level === 'warn')
    expect(warnings).toHaveLength(2)
    expect(warnings[0]?.message).toContain('im:message.reactions:write_only')
    expect(warnings[0]?.message).toContain('code=99991672')
    expect(warnings[1]?.message).toContain('rate-limit')
    expect(warnings[1]?.message).toContain('1000 reactions/min')
    expect(warnings[1]?.message).toContain('code=99991400')
  })

  it('logs the Feishu business code and msg for an unclassified ack failure without leaking the payload', async () => {
    const { bridge, gateway, logs } = setup()
    gateway.reactionFailures.push(Object.assign(new Error('Request failed with status code 400'), {
      code: 'ERR_BAD_REQUEST',
      config: {
        data: '{"reaction_type":{"emoji_type":"OK"}}',
        headers: { Authorization: 'Bearer token-fixture' },
      },
      response: {
        status: 400,
        data: { code: 231022, msg: '用户不在应用机器人的可用范围' },
      },
    }))
    await bridge.receive(feishuEvent())
    await bridge.drain()
    const warnings = logs.filter(log => log.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('Feishu reaction ack failed (other)')
    // A recalled message (231003) and an out-of-range user (231022) both used to
    // surface as the same bare axios status message; the detail tells them apart.
    expect(warnings[0]?.message).toContain('code=231022 status=400 msg=用户不在应用机器人的可用范围')
    expect(warnings[0]?.message).not.toContain('reaction_type')
    expect(warnings[0]?.message).not.toContain('token-fixture')
  })

  it('cancels a stalled acknowledgement when the bridge stops', async () => {
    const { bridge, gateway } = setup([], { ackTimeoutMs: 60_000 })
    let signal: AbortSignal | undefined
    gateway.addReaction = (_messageId: string, _emojiType: string, reactionSignal?: AbortSignal) => {
      signal = reactionSignal
      return new Promise<void>(() => {})
    }
    await bridge.receive(feishuEvent())
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(signal?.aborted).toBe(false)
    await bridge.stop()
    await bridge.drain()
    // The bridge lifecycle aborts the ack instead of waiting for its 60s bound.
    expect(signal?.aborted).toBe(true)
    expect(gateway.stops).toBe(1)
  })

  it('does not react when prompt admission fails and preserves the delivery-error notice', async () => {
    const { bridge, gateway, sessions } = setup()
    sessions.promptHook = async () => { throw new Error('Session is unavailable') }
    await bridge.receive(feishuEvent())
    await bridge.drain()
    expect(gateway.reactionAttempts).toEqual([])
    expect(gateway.sent[0]?.text).toContain('暂时无法投递')
  })
})

describe('OmniBridge assistant markdown cards', () => {
  function longMarkdown(paragraphs = 600): string {
    return Array.from(
      { length: paragraphs },
      (_, index) => `## 段落 ${index + 1}\n\n这是第 ${index + 1} 段的内容，包含 **加粗**、\`行内代码\` 与 [链接](https://example.test/${index})。`,
    ).join('\n\n')
  }

  async function assistantTurn(bridge: OmniBridge, text: string, turn = 1): Promise<void> {
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, text, turn))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2, turn))
    await bridge.drain()
  }

  it('sends one Card JSON 2.0 markdown card carrying the original reply and the [助手] marker', async () => {
    const { bridge, gateway, errors } = setup([alice])
    const answer = '# 标题\n\n- 列表一\n- 列表二\n\n```ts\nconst x = 1\n```\n\n[链接](https://example.test)'
    await assistantTurn(bridge, answer)
    expect(gateway.sent).toEqual([])
    expect(gateway.cardAttempts).toHaveLength(1)
    const card = gateway.cards[0]
    expect(card?.title).toBe('[助手]')
    expect(card?.markdown).toBe(answer)
    const content = buildAssistantCard(card?.markdown ?? '', { title: card?.title ?? '' })
    const parsed = JSON.parse(content) as {
      schema: string
      header: { title: { tag: string; content: string } }
      body: { elements: { tag: string; content: string }[] }
    }
    expect(parsed.schema).toBe('2.0')
    expect(parsed.header.title).toEqual({ tag: 'plain_text', content: '[助手]' })
    expect(parsed.body.elements).toEqual([{ tag: 'markdown', content: answer }])
    expect(content).toContain('[助手]')
    expect(errors).toEqual([])
  })

  it('splits long replies into ordered (i/n) cards with deterministic uuids', async () => {
    const text = longMarkdown()
    const first = setup([alice])
    await assistantTurn(first.bridge, text)
    const cards = first.gateway.cards
    const total = cards.length
    expect(total).toBeGreaterThan(1)
    expect(cards.map(card => card.title))
      .toEqual(cards.map((_, index) => assistantCardTitle(index + 1, total)))
    for (const [index, card] of cards.entries()) {
      expect(card.title).toBe(`[助手] (${index + 1}/${total})`)
      expect(card.markdown.trim().length).toBeGreaterThan(0)
      expect(estimateCardRequestBytes(card.markdown, { title: card.title ?? '[助手]' }))
        .toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES)
    }
    expect(new Set(cards.map(card => card.uuid)).size).toBe(total)
    // The same logical reply always yields the same split and UUID sequence.
    const second = setup([alice])
    await assistantTurn(second.bridge, text)
    expect(second.gateway.cards.map(card => card.markdown)).toEqual(cards.map(card => card.markdown))
    expect(second.gateway.cards.map(card => card.uuid)).toEqual(cards.map(card => card.uuid))
    expect(splitAssistantMarkdown(text)).toHaveLength(total)
  })

  it('keeps quote-heavy replies inside the request-body budget after both escaping passes', async () => {
    const { bridge, gateway } = setup([alice])
    const answer = `引用密集：${'"\\'.repeat(20_000)}`
    await assistantTurn(bridge, answer)
    expect(gateway.cards.length).toBeGreaterThan(1)
    for (const card of gateway.cards) {
      expect(estimateCardRequestBytes(card.markdown, { title: card.title ?? '[助手]' }))
        .toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES)
    }
  })

  it('retries rate-limited cards with the same uuid before falling back', async () => {
    const { bridge, gateway, sleeps } = setup([alice])
    gateway.cardFailures.set('oc_alice', [Object.assign(new Error('rate limited'), { code: 230020 })])
    await assistantTurn(bridge, 'answer')
    expect(gateway.cardAttempts).toHaveLength(2)
    expect(new Set(gateway.cardAttempts.map(row => row.uuid)).size).toBe(1)
    expect(gateway.cards).toHaveLength(1)
    expect(gateway.sent).toEqual([])
    expect(sleeps).toEqual([10])
  })

  it('closes and reopens code fences instead of cutting through them', async () => {
    const codeLines = Array.from(
      { length: 900 },
      (_, index) => `const value${index} = ${index} // padded line for the fence split test`,
    )
    const { bridge, gateway } = setup([alice])
    await assistantTurn(bridge, `说明：\n\n\`\`\`ts\n${codeLines.join('\n')}\n\`\`\`\n\n结束。`)
    expect(gateway.cards.length).toBeGreaterThan(1)
    for (const card of gateway.cards) {
      const fences = card.markdown.split('\n').filter(line => /^ {0,3}(`{3,}|~{3,})/.test(line))
      expect(fences.length % 2).toBe(0)
    }
    const preserved = gateway.cards
      .flatMap(card => card.markdown.split('\n'))
      .filter(line => line.startsWith('const value'))
    expect(preserved).toEqual(codeLines)
  })

  it('falls back to plain text when Feishu rejects the card payload, reusing the uuid', async () => {
    const { bridge, gateway, errors } = setup([alice])
    gateway.cardFailures.set('oc_alice', [Object.assign(new Error('card content invalid'), { code: 230099 })])
    const answer = '# 标题\n\n正文'
    await assistantTurn(bridge, answer)
    // A rejected payload is not retried: the same JSON cannot succeed later.
    expect(gateway.cardAttempts).toHaveLength(1)
    expect(gateway.cards).toEqual([])
    expect(gateway.sent).toHaveLength(1)
    expect(gateway.sent[0]?.text).toBe(`[助手]\n${answer}`)
    expect(gateway.sent[0]?.uuid).toBe(gateway.cardAttempts[0]?.uuid)
    // The fallback never leaks card JSON.
    expect(gateway.sent[0]?.text).not.toContain('"schema"')
    expect(gateway.sent[0]?.text).not.toContain('"elements"')
    expect(errors).toEqual([])
  })

  it('never duplicates an uncertain card outcome: fallback text reuses the same uuid', async () => {
    const { bridge, gateway } = setup([alice])
    gateway.cardFailures.set('oc_alice', [new Error('timeout'), new Error('timeout'), new Error('timeout')])
    await assistantTurn(bridge, 'answer')
    expect(gateway.cardAttempts).toHaveLength(3)
    expect(gateway.sent).toHaveLength(1)
    // Same uuid everywhere: Feishu sends at most one message per uuid in an
    // hour, so a card that actually landed cannot be duplicated by the text.
    expect(new Set([...gateway.cardAttempts, ...gateway.sent].map(row => row.uuid)).size).toBe(1)
  })

  it('keeps the (i/n) marker when a numbered part falls back to plain text', async () => {
    const { bridge, gateway } = setup([alice])
    const text = longMarkdown()
    const total = splitAssistantMarkdown(text).length
    expect(total).toBeGreaterThan(1)
    gateway.cardFailures.set('oc_alice', [Object.assign(new Error('card content invalid'), { code: 230099 })])
    await assistantTurn(bridge, text)
    expect(gateway.sent).toHaveLength(1)
    expect(gateway.sent[0]?.text.startsWith(`[助手] (1/${total})\n`)).toBe(true)
    // Remaining parts are still delivered as cards, in order.
    expect(gateway.cards).toHaveLength(total - 1)
    expect(gateway.cards[0]?.title).toBe(`[助手] (2/${total})`)
  })

  it('aborts a permanently stalled card send so stop and the global queue finish', async () => {
    const { bridge, gateway } = setup([alice])
    let calls = 0
    gateway.sendMarkdown = () => {
      calls += 1
      return new Promise<void>(() => {})
    }
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent())
    await bridge.sessionEvent(SESSION.sessionId, turnEnd())
    await vi.waitFor(() => expect(calls).toBe(1))
    await bridge.stop()
    await bridge.drain()
    expect(gateway.stops).toBe(1)
  })

  it('does not retry or fall back for permanent recipient failures', async () => {
    const { bridge, gateway, errors } = setup([alice])
    gateway.cardFailures.set('oc_alice', [Object.assign(new Error('bot removed'), { code: 230002 })])
    await assistantTurn(bridge, 'answer')
    expect(gateway.cardAttempts).toHaveLength(1)
    expect(gateway.cards).toEqual([])
    expect(gateway.sent).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('stops the remaining chunks for a recipient after a permanent failure but keeps other recipients whole', async () => {
    const { bridge, gateway } = setup([alice, bob])
    const text = longMarkdown()
    const total = splitAssistantMarkdown(text).length
    expect(total).toBeGreaterThan(2)
    const original = gateway.sendMarkdown.bind(gateway)
    let aliceCards = 0
    gateway.sendMarkdown = async (chatId, markdown, uuid, signal, options) => {
      if (chatId === 'oc_alice') {
        aliceCards += 1
        if (aliceCards === 2) throw Object.assign(new Error('bot removed'), { code: 230002 })
      }
      return original(chatId, markdown, uuid, signal, options)
    }
    await assistantTurn(bridge, text)
    expect(gateway.cards.filter(card => card.chatId === 'oc_alice')).toHaveLength(1)
    expect(gateway.cards.filter(card => card.chatId === 'oc_bob')).toHaveLength(total)
  })

  it('keeps mirrored user messages and test messages on plain text', async () => {
    const { bridge, gateway } = setup([alice])
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, 'hello', 'feishu-omni:om_1:oc_other'))
    await bridge.sendTest()
    await bridge.drain()
    expect(gateway.cards).toEqual([])
    expect(gateway.sent.map(row => row.text)).toEqual([
      'hello',
      '[Feishu Omni] 测试消息：DSH 与飞书连接正常。',
    ])
  })
})
