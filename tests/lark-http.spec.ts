import * as Lark from '@larksuiteoapi/node-sdk'
import type { AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { describe, expect, it } from 'vitest'
import { createHttpInstance } from '../src/lark.ts'

const APP_ID = 'cli_0123456789abcdef'
const quietLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} }

function response(config: InternalAxiosRequestConfig, data: unknown, headers: Record<string, string> = {}): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers, config }
}

describe('SDK-compatible HTTP instance (local adapters only)', () => {
  it('unwraps token and message responses for the real SDK Client', async () => {
    const http = createHttpInstance()
    const urls: string[] = []
    http.defaults.adapter = async config => {
      const url = config.url ?? ''
      urls.push(url)
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return response(config, { code: 0, msg: 'ok', tenant_access_token: 'fake-token', expire: 7200 })
      }
      return response(config, { code: 0, msg: 'ok', data: { message_id: 'om_fake' } })
    }
    const client = new Lark.Client({
      appId: APP_ID, appSecret: 'secret-fixture', httpInstance: http, logger: quietLogger,
    })
    const result = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_fake', msg_type: 'text', content: '{"text":"hello"}', uuid: 'dshfo_fake' },
    })
    expect(result.code).toBe(0)
    const cardResult = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_fake',
        msg_type: 'interactive',
        content: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: '# hi' }] } }),
        uuid: 'dshfo_card',
      },
    })
    expect(cardResult.code).toBe(0)
    expect(urls.some(url => url.includes('/auth/v3/tenant_access_token/internal'))).toBe(true)
    expect(urls.some(url => url.includes('/im/v1/messages'))).toBe(true)
  })

  it('posts an emoji reaction through the real SDK client on the documented endpoint', async () => {
    const http = createHttpInstance()
    const requests: { url: string; method: string; data: unknown }[] = []
    http.defaults.adapter = async config => {
      const url = config.url ?? ''
      requests.push({ url, method: config.method ?? '', data: config.data })
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return response(config, { code: 0, msg: 'ok', tenant_access_token: 'fake-token', expire: 7200 })
      }
      return response(config, { code: 0, msg: 'ok', data: { reaction_id: 'reaction-1' } })
    }
    const client = new Lark.Client({
      appId: APP_ID, appSecret: 'secret-fixture', httpInstance: http, logger: quietLogger,
    })
    const result = await client.im.v1.messageReaction.create({
      path: { message_id: 'om_original' },
      data: { reaction_type: { emoji_type: 'OK' } },
    })
    expect(result.code).toBe(0)
    const reactionRequest = requests.find(request => request.url.includes('/reactions'))
    expect(reactionRequest?.url).toContain('/open-apis/im/v1/messages/om_original/reactions')
    expect(reactionRequest?.method).toBe('post')
    expect(JSON.parse(String(reactionRequest?.data))).toEqual({ reaction_type: { emoji_type: 'OK' } })
  })

  it('unwraps the WebSocket endpoint response for the real WSClient', async () => {
    const http = createHttpInstance()
    http.defaults.adapter = async config => response(config, {
      code: 0,
      msg: 'ok',
      data: {
        URL: 'wss://example.test/socket?device_id=device&service_id=service',
        ClientConfig: { PingInterval: 120, ReconnectCount: 3, ReconnectInterval: 1, ReconnectNonce: 0 },
      },
    })
    const ws = new Lark.WSClient({
      appId: APP_ID, appSecret: 'secret-fixture', httpInstance: http, logger: quietLogger,
    })
    const result = await (ws as unknown as { pullConnectConfig(): Promise<{ ok: boolean }> }).pullConnectConfig()
    expect(result.ok).toBe(true)
    ws.close({ force: true })
  })

  it('preserves the SDK $return_headers response branch', async () => {
    const http = createHttpInstance()
    http.defaults.adapter = async config => response(config, { code: 0 }, { 'x-fixture': 'yes' })
    const result = await http.request({
      method: 'GET', url: 'https://example.test/resource', $return_headers: true,
    } as AxiosRequestConfig)
    expect(result.data).toEqual({ code: 0 })
    expect(result.headers['x-fixture']).toBe('yes')
  })
})
