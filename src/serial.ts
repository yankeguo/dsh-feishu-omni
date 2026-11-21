/** A failure-isolated FIFO queue for inbound events and outbound session events. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  get isClosed(): boolean {
    return this.closed
  }

  close(): void {
    this.closed = true
  }

  async drain(): Promise<void> {
    await this.tail
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Feishu Omni bridge is stopped'))
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
