import { describe, expect, it } from 'vitest'
import { SerialQueue } from '../src/serial.ts'

describe('SerialQueue', () => {
  it('runs concurrent work in FIFO order and continues after failure', async () => {
    const queue = new SerialQueue()
    const order: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = queue.run(async () => {
      order.push('first:start')
      await gate
      order.push('first:end')
      throw new Error('expected failure')
    })
    const second = queue.run(async () => { order.push('second') })
    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    release?.()
    await expect(first).rejects.toThrow('expected failure')
    await expect(second).resolves.toBeUndefined()
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('rejects new work after close but drains accepted work', async () => {
    const queue = new SerialQueue()
    queue.close()
    await queue.drain()
    await expect(queue.run(async () => undefined)).rejects.toThrow(/stopped/)
  })
})
