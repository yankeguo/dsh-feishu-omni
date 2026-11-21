import { describe, expect, it } from 'vitest'
import { defaultAttachmentRoot, defaultStatePath } from '../src/index.ts'

describe('defaultAttachmentRoot', () => {
  it('follows the documented DSH_HOME convention', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = '/tmp/dsh-home-fixture'
    try {
      expect(defaultAttachmentRoot()).toBe('/tmp/dsh-home-fixture/attachments/v1')
      // The attachment store keeps its own convention under the same DSH home.
      expect(defaultStatePath()).toBe('/tmp/dsh-home-fixture/integrations/dsh-feishu-omni/state.json')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
