import { describe, expect, it } from 'vitest'
import {
  assistantCardTitle, assistantFallbackText, buildAssistantCard, CARD_REQUEST_MAX_BYTES,
  estimateCardRequestBytes, splitAssistantMarkdown,
} from '../src/card.ts'

function requestBytes(markdown: string, title: string): number {
  return estimateCardRequestBytes(markdown, { title })
}

function paragraph(index: number): string {
  return `## 段落 ${index}\n\n第 ${index} 段内容，含 **加粗**、\`code\` 与 [链接](https://example.test/${index})。`
}

describe('assistant card payload', () => {
  it('builds a legal Card JSON 2.0 body with one markdown element', () => {
    const content = buildAssistantCard('# 标题\n\n- 一\n- 二\n\n```ts\nconst x = 1\n```')
    const card = JSON.parse(content) as {
      schema: string
      header: { title: { tag: string; content: string }; template: string }
      body: { elements: { tag: string; content: string }[] }
    }
    expect(card.schema).toBe('2.0')
    expect(card.header).toEqual({
      title: { tag: 'plain_text', content: '[助手]' },
      template: 'blue',
    })
    expect(card.body.elements).toEqual([{
      tag: 'markdown',
      content: '# 标题\n\n- 一\n- 二\n\n```ts\nconst x = 1\n```',
    }])
    expect(content).toContain('[助手]')
  })

  it('supports a replacement title for numbered chunks and a text fallback', () => {
    const card = JSON.parse(buildAssistantCard('body', { title: assistantCardTitle(2, 3) })) as {
      header: { title: { content: string } }
    }
    expect(card.header.title.content).toBe('[助手] (2/3)')
    expect(assistantCardTitle(1, 1)).toBe('[助手]')
    expect(assistantFallbackText('# 标题\n正文')).toBe('[助手]\n# 标题\n正文')
    expect(assistantFallbackText('正文', '[助手] (1/2)')).toBe('[助手] (1/2)\n正文')
  })
})

describe('assistant markdown chunking', () => {
  it('returns the exact original text when a single card is enough', () => {
    const markdown = '# 标题\n\n\n- 一\n- 二\n\n```ts\nconst x = 1\n```  \n'
    expect(splitAssistantMarkdown(markdown)).toEqual([markdown])
  })

  it('returns no chunk for empty input', () => {
    expect(splitAssistantMarkdown('')).toEqual([])
  })

  it('keeps paragraph boundaries and rejoins to the original text', () => {
    const markdown = Array.from({ length: 600 }, (_, index) => paragraph(index + 1)).join('\n\n')
    expect(Buffer.byteLength(markdown, 'utf8')).toBeGreaterThan(CARD_REQUEST_MAX_BYTES)
    const chunks = splitAssistantMarkdown(markdown)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('\n\n')).toBe(markdown)
    for (const [index, chunk] of chunks.entries()) {
      expect(requestBytes(chunk, assistantCardTitle(index + 1, chunks.length)))
        .toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES)
      // Every chunk consists of whole paragraphs: no mid-paragraph cut.
      for (const block of chunk.split('\n\n')) {
        expect(markdown.split('\n\n')).toContain(block)
      }
    }
  })

  it('hard-splits a single over-long line at code-point boundaries without losing text', () => {
    const markdown = `前缀 ${'长'.repeat(40_000)}`
    const chunks = splitAssistantMarkdown(markdown)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(markdown)
    for (const [index, chunk] of chunks.entries()) {
      expect(estimateCardRequestBytes(chunk, { title: assistantCardTitle(index + 1, chunks.length) }))
        .toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES)
    }
  })

  it('accounts for the second JSON escaping pass of the HTTP request body', () => {
    // Each quote/backslash becomes two bytes inside the card JSON and four bytes
    // in the request body, so a naive "card JSON only" budget would overflow.
    const markdown = '"\\'.repeat(30_000)
    const chunks = splitAssistantMarkdown(markdown)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(markdown)
    for (const [index, chunk] of chunks.entries()) {
      const title = assistantCardTitle(index + 1, chunks.length)
      expect(requestBytes(chunk, title)).toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES)
      // The raw card JSON is smaller than the request body but must also stay sane.
      expect(Buffer.byteLength(buildAssistantCard(chunk, { title }), 'utf8'))
        .toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES)
      // Reproduce the SDK request body: the card JSON is the `content` string.
      const body = JSON.stringify({
        receive_id: 'oc_0123456789abcdef0123456789abcdef',
        msg_type: 'interactive',
        content: buildAssistantCard(chunk, { title }),
        uuid: `dshfo_${'a'.repeat(40)}`,
      })
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(30_000)
    }
  })

  it('closes and reopens an oversized fenced code block with the same info string', () => {
    const codeLines = Array.from(
      { length: 800 },
      (_, index) => `const value${index} = ${index} // padded line for fence splitting`,
    )
    const markdown = `说明：\n\n\`\`\`ts\n${codeLines.join('\n')}\n\`\`\`\n\n结束。`
    const chunks = splitAssistantMarkdown(markdown)
    expect(chunks.length).toBeGreaterThan(1)
    const preserved: string[] = []
    for (const chunk of chunks) {
      const lines = chunk.split('\n')
      const fenceIndexes = lines
        .map((line, index) => (/^ {0,3}(`{3,}|~{3,})/.test(line) ? index : -1))
        .filter(index => index >= 0)
      expect(fenceIndexes.length % 2).toBe(0)
      if (!chunk.includes('```ts')) continue
      const opening = fenceIndexes[0] ?? -1
      const closing = fenceIndexes[fenceIndexes.length - 1] ?? -1
      expect(lines[opening]).toBe('```ts')
      expect(lines[closing]).toBe('```')
      preserved.push(...lines.slice(opening + 1, closing).filter(line => line.startsWith('const value')))
    }
    expect(preserved).toEqual(codeLines)
    expect(chunks.join('\n\n')).toContain('结束。')
  })

  it('closes an unclosed fence in every produced chunk', () => {
    const markdown = `\`\`\`js\n${Array.from({ length: 1_600 }, (_, index) => `console.log(${index}) // padding`).join('\n')}`
    const chunks = splitAssistantMarkdown(markdown)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const fences = chunk.split('\n').filter(line => /^ {0,3}(`{3,}|~{3,})/.test(line))
      expect(fences).toHaveLength(2)
      expect(chunk.startsWith('```js\n')).toBe(true)
      expect(chunk.endsWith('```')).toBe(true)
    }
  })

  it('normalizes CRLF only when a split is required', () => {
    const short = '# 标题\r\n正文'
    expect(splitAssistantMarkdown(short)).toEqual([short])
    const long = Array.from({ length: 900 }, (_, index) => `line ${index} ${'x'.repeat(40)}\r`).join('\n')
    const chunks = splitAssistantMarkdown(long)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk).not.toContain('\r')
  })

  it('honors a custom per-message request budget and stays deterministic', () => {
    const markdown = Array.from({ length: 120 }, (_, index) => paragraph(index + 1)).join('\n\n')
    const first = splitAssistantMarkdown(markdown, 3_000)
    const second = splitAssistantMarkdown(markdown, 3_000)
    expect(first.length).toBeGreaterThan(2)
    expect(second).toEqual(first)
    expect(first.join('\n\n')).toBe(markdown)
    for (const [index, chunk] of first.entries()) {
      expect(requestBytes(chunk, assistantCardTitle(index + 1, first.length))).toBeLessThanOrEqual(3_000)
    }
  })

  it('keeps a small GFM table inside one chunk', () => {
    const table = '| 列一 | 列二 |\n| --- | --- |\n| a | b |\n| c | d |'
    const markdown = `${Array.from({ length: 500 }, (_, index) => paragraph(index + 1)).join('\n\n')}\n\n${table}`
    const chunks = splitAssistantMarkdown(markdown)
    expect(chunks.some(chunk => chunk.includes(table))).toBe(true)
  })

  it('splits a table larger than one card at row boundaries without dropping rows', () => {
    const rows = Array.from({ length: 800 }, (_, index) => `| 行 ${index} | 值 ${index} ${'x'.repeat(20)} |`)
    const table = `| 名称 | 值 |\n| --- | --- |\n${rows.join('\n')}`
    const chunks = splitAssistantMarkdown(`${paragraph(1)}\n\n${table}`)
    expect(chunks.length).toBeGreaterThan(1)
    for (const [index, chunk] of chunks.entries()) {
      expect(requestBytes(chunk, assistantCardTitle(index + 1, chunks.length)))
        .toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES)
    }
    expect(chunks.flatMap(chunk => chunk.split('\n')).filter(line => line.startsWith('| 行')))
      .toEqual(rows)
  })

  it('keeps request bodies under both budgets for deterministic randomized content', () => {
    let seed = 0x9e3779b9
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed
    }
    const chars = ['长', 'a', '"', '\\', '`', ' ', '中', '😀', '\t', '|', '-', '#', '*', '[', ']']
    const pick = (items: readonly string[]): string => items[next() % items.length] ?? ''
    const word = (): string => Array.from({ length: 1 + (next() % 40) }, () => pick(chars)).join('')
    const block = (): string => {
      switch (next() % 5) {
        case 0:
          return Array.from({ length: 1 + (next() % 6) }, () => `段落 ${word()}`).join('\n')
        case 1:
          return `\`\`\`${pick(['ts', 'js', '', 'bash'])}\n${Array.from(
            { length: 1 + (next() % 80) }, (_, index) => `line ${index}: ${word()}`,
          ).join('\n')}\n\`\`\``
        case 2:
          return `\`\`\`\n${Array.from(
            { length: 1 + (next() % 200) }, (_, index) => `x${index} ${word()}`,
          ).join('\n')}`
        case 3:
          return `| a | b |\n| --- | --- |\n${Array.from(
            { length: 1 + (next() % 10) }, () => `| ${word()} | ${word()} |`,
          ).join('\n')}`
        default:
          return word().repeat(1 + (next() % 10))
      }
    }
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const markdown = Array.from({ length: 1 + (next() % 25) }, block).join('\n\n')
      const chunks = splitAssistantMarkdown(markdown)
      for (const [index, chunk] of chunks.entries()) {
        const title = assistantCardTitle(index + 1, chunks.length)
        expect(estimateCardRequestBytes(chunk, { title })).toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES)
        const body = JSON.stringify({
          receive_id: 'oc_0123456789abcdef0123456789abcdef',
          msg_type: 'interactive',
          content: buildAssistantCard(chunk, { title }),
          uuid: `dshfo_${'a'.repeat(40)}`,
        })
        expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(30_000)
      }
    }
  })
})
