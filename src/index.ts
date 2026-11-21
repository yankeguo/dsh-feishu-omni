import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { OmniController } from './controller.ts'
import { DshAttachmentPort, DshCredentialPort, DshFileUploadPort, DshSessionPort } from './host-adapters.ts'
import { createLarkGatewayFactory } from './lark.ts'
import { registerManagementRoute } from './management.ts'
import { FileStateStore } from './state.ts'

export const name = 'feishu-omni'
export const inject = ['connection', 'credentials', 'sessionController', 'sessions']

export interface Config {
  /** Test/deployment override; empty selects $DSH_HOME/integrations/dsh-feishu-omni/state.json. */
  readonly statePath: string
}

export const Config: z<Partial<Config>, Config> = z.object({
  statePath: z.string().default(''),
})

export function defaultStatePath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'integrations', 'dsh-feishu-omni', 'state.json')
}

/** Mount the Host half. No listener, port, DSH process or profile file is created. */
export async function apply(ctx: Context, rawConfig: Partial<Config> = {}): Promise<void> {
  const config = Config(rawConfig)
  const logger = ctx.logger(name)
  // Attachment services are optional so a stripped Host composition still
  // loads and degrades image/file input to a text notice instead of failing.
  const fileUploads = DshFileUploadPort.from(ctx)
  const attachments = DshAttachmentPort.from(ctx)
  const controller = new OmniController({
    state: new FileStateStore(config.statePath || defaultStatePath()),
    sessions: new DshSessionPort(ctx),
    credentials: new DshCredentialPort(ctx),
    gatewayFactory: createLarkGatewayFactory(),
    logger,
    ...(fileUploads === undefined ? {} : { fileUploads }),
    ...(attachments === undefined ? {} : { attachments }),
  })
  await controller.initialize()
  ctx.effect(() => registerManagementRoute(ctx, controller), 'feishu-omni: management route')
  // The listener's first argument is the live Session, so the bridge can learn
  // the Session cwd for relative Markdown image / present paths without I/O.
  ctx.on('session/event', (session, event) => {
    controller.sessionEvent(session.id, event, session.header?.cwd)
  }, { global: true })
  ctx.effect(() => async () => controller.close(), 'feishu-omni: close bridge')
}
