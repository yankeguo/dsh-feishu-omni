/** DSH Client entry: dictionaries, styles, and the `feishu-omni` settings section. */

import type { ComponentType } from 'react'
import { RPC_ENDPOINT, type ManagementMethod, type ManagementResult } from '../public.ts'
import { en, FEISHU_OMNI_LOCALE_NAMESPACE, zh } from './locales.ts'
import type { ManagementRequest, ManagementRpc } from './rpc.ts'
import { FeishuOmniSettings, type FeishuOmniSettingsProps, type Translate } from './Settings.tsx'
import { ensureStyleTag } from './styles.ts'

export const inject = ['slots', 'connection', 'locale']

interface ConnectionService {
  readonly rpc: {
    call<M extends ManagementMethod>(
      endpoint: '/api',
      channel: string,
      request: ManagementRequest<M>,
      signal: AbortSignal,
    ): Promise<ManagementResult>
  }
}

interface LocaleService {
  register(
    namespace: string,
    dictionaries: { readonly zh: Record<string, string>; readonly en: Record<string, string> },
  ): () => void
  bind(namespace: string): Translate
}

export interface SettingsSectionRegistration {
  readonly name: 'settings.section'
  readonly id: 'feishu-omni'
  readonly order: number
  readonly label: () => string
  readonly locale: typeof FEISHU_OMNI_LOCALE_NAMESPACE
  readonly inject: () => { readonly rpcCall: ManagementRpc }
}

export interface BundleConfigRegistration {
  readonly name: 'plugins.bundle.config'
  readonly key: '@yankeguo/dsh-feishu-omni'
  readonly locale: typeof FEISHU_OMNI_LOCALE_NAMESPACE
  readonly inject: () => { readonly rpcCall: ManagementRpc }
}

interface SlotsService {
  inject(name: 'settings.section' | 'plugins.bundle.config', callback: () => () => void): () => void
  register(
    options: SettingsSectionRegistration | BundleConfigRegistration,
    component: ComponentType<FeishuOmniSettingsProps>,
  ): () => void
}

/** Structural Client context: kept local so registration tests need no DSH runtime. */
export interface FeishuOmniClientContext {
  readonly connection: ConnectionService
  readonly locale: LocaleService
  readonly slots: SlotsService
  effect(effect: () => void | (() => void), label: string): void
}

/** Register the browser half without performing any management request itself. */
export function apply(ctx: FeishuOmniClientContext): void {
  ctx.effect(
    () => ctx.locale.register(FEISHU_OMNI_LOCALE_NAMESPACE, { zh, en }),
    'feishu-omni: dictionaries',
  )
  ctx.effect(() => ensureStyleTag(), 'feishu-omni: styles')

  const labelTranslator = ctx.locale.bind(FEISHU_OMNI_LOCALE_NAMESPACE)
  const rpcCall: ManagementRpc = (method, payload, signal) => ctx.connection.rpc.call(
    '/api',
    RPC_ENDPOINT,
    { method, payload },
    signal,
  )
  const face = Object.freeze({ rpcCall })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'feishu-omni',
    order: 22,
    label: () => labelTranslator('section.label'),
    locale: FEISHU_OMNI_LOCALE_NAMESPACE,
    inject: () => face,
  }, FeishuOmniSettings))

  // The installed Plugin Manager uses a package-keyed configuration seat;
  // settings.section alone does not create a bundle Configure action.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@yankeguo/dsh-feishu-omni',
    locale: FEISHU_OMNI_LOCALE_NAMESPACE,
    inject: () => face,
  }, FeishuOmniSettings))
}

export { FeishuOmniSettings } from './Settings.tsx'
export {
  ManagementRpcError,
  parseOmniStatus,
  parseSessionOptions,
  parseTestResult,
  unwrapRpcResult,
} from './rpc.ts'
