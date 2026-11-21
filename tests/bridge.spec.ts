import { describe, expect, it, vi } from 'vitest'
import { OmniBridge } from '../src/bridge.ts'
import {
  assistantCardTitle, buildAssistantCard, CARD_REQUEST_MAX_BYTES, estimateCardRequestBytes, splitAssistantMarkdown,
} from '../src/card.ts'
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
  it('broadcasts human input as text and final assistant replies as markdown cards', async () => {
    const { bridge, gateway } = setup([alice, bob])
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, '[飞书 · Alice]\nquestion'))
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(2, 'answer'))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(3))
    await bridge.drain()
    expect(gateway.sent.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob'])
    expect(gateway.sent[0]?.text).toBe('[飞书 · Alice]\nquestion')
    expect(gateway.cards.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob'])
    expect(gateway.cards.map(row => row.markdown)).toEqual(['answer', 'answer'])
    expect(gateway.cards.map(row => row.title)).toEqual(['[助手]', '[助手]'])
    const uuids = [...gateway.sent, ...gateway.cards].map(row => row.uuid)
    expect(new Set(uuids).size).toBe(4)
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
    expect(gateway.cards).toEqual([])
    expect(gateway.sent).toEqual([])
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
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, 'hello'))
    await bridge.sendTest()
    await bridge.drain()
    expect(gateway.cards).toEqual([])
    expect(gateway.sent.map(row => row.text)).toEqual([
      'hello',
      '[Feishu Omni] 测试消息：DSH 与飞书连接正常。',
    ])
  })
})
