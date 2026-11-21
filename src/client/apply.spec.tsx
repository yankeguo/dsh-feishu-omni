import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { RPC_ENDPOINT, type ManagementMethod, type ManagementResult } from '../public.ts'
import {
  apply,
  inject,
  type BundleConfigRegistration,
  type FeishuOmniClientContext,
  type SettingsSectionRegistration,
} from './index.tsx'
import type { ManagementRequest } from './rpc.ts'
import type { FeishuOmniSettingsProps } from './Settings.tsx'

interface RecordedRegistration {
  readonly options: SettingsSectionRegistration | BundleConfigRegistration
  readonly component: ComponentType<FeishuOmniSettingsProps>
}

interface RecordedCall {
  readonly endpoint: string
  readonly channel: string
  readonly request: unknown
  readonly signal: AbortSignal
}

function fakeContext() {
  const effects: string[] = []
  const registrations: RecordedRegistration[] = []
  const calls: RecordedCall[] = []
  const dictionaries: string[] = []
  const injectedSlots: string[] = []
  const ctx: FeishuOmniClientContext = {
    connection: {
      rpc: {
        call: <M extends ManagementMethod>(
          endpoint: '/api',
          channel: string,
          request: ManagementRequest<M>,
          signal: AbortSignal,
        ): Promise<ManagementResult> => {
          calls.push({ endpoint, channel, request, signal })
          return Promise.resolve({ ok: true, value: null })
        },
      },
    },
    locale: {
      register(namespace) {
        dictionaries.push(namespace)
        return () => {}
      },
      bind: namespace => key => `${namespace}.${key}`,
    },
    slots: {
      inject(name, callback) {
        injectedSlots.push(name)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect(effect, label) {
      effects.push(label)
      effect()
    },
  }
  return { ctx, effects, registrations, calls, dictionaries, injectedSlots }
}

describe('Client apply', () => {
  it('declares exactly the required services and registers dictionaries and styles', () => {
    const fake = fakeContext()
    expect(inject).toEqual(['slots', 'connection', 'locale'])
    apply(fake.ctx)
    expect(fake.effects).toEqual(['feishu-omni: dictionaries', 'feishu-omni: styles'])
    expect(fake.dictionaries).toEqual(['feishuOmni'])
    expect(fake.calls).toHaveLength(0)
  })

  it('registers the feishu-omni settings section with its RPC face', async () => {
    const fake = fakeContext()
    apply(fake.ctx)
    expect(fake.injectedSlots).toEqual(['settings.section', 'plugins.bundle.config'])
    expect(fake.registrations).toHaveLength(2)
    const registration = fake.registrations[0]
    expect(registration?.options).toMatchObject({
      name: 'settings.section', id: 'feishu-omni', locale: 'feishuOmni',
    })
    if (registration?.options.name !== 'settings.section') throw new Error('missing settings registration')
    expect(registration.options.label()).toBe('feishuOmni.section.label')
    const face = registration.options.inject()
    const signal = new AbortController().signal
    await face?.rpcCall('status', {}, signal)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({
      endpoint: '/api',
      channel: RPC_ENDPOINT,
      request: { method: 'status', payload: {} },
      signal,
    })
  })

  it('also registers the package-keyed Plugin Manager configuration seat', () => {
    const fake = fakeContext()
    apply(fake.ctx)
    expect(fake.registrations[1]?.options).toMatchObject({
      name: 'plugins.bundle.config', key: '@yankeguo/dsh-feishu-omni', locale: 'feishuOmni',
    })
  })
})
