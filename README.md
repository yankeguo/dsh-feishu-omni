# dsh-feishu-omni

把一个**既有 DeepSeek Harness（DSH）Session**变成飞书里的共享指挥频道：多位飞书用户向同一个机器人发言，消息进入同一个 Session；该 Session 的人类输入和助手最终回复再广播给所有已绑定用户。助手最终回复使用飞书卡片渲染 Markdown（标题、列表、代码块、链接、表格），而不是把 Markdown 当纯文本显示。

主要用途是配合 **DevLead**：团队成员在同一个 lead Session 中发言，看到彼此进入对话的消息以及 DevLead 的最终回复。

> **安全提示：这是共享控制面，不是只读群聊。** 任何在飞书应用可用范围内、能私聊该机器人的用户，首次发言都会被绑定，并能向所选 Session 提交指令。请限制企业自建应用的可用范围，并只绑定你信任这些用户共同操作的 Session。

## 与常见 IM 插件的区别

常见的 DSH IM 接入（包括参考实现 [`xmanrui/dsh-im`](https://github.com/xmanrui/dsh-im)）通常按 IM 用户/会话创建独立 DSH Session。本插件刻意采用相反模型：

- 只选择一个已经存在的普通 DSH Session，不自动创建 Session；
- 所有飞书单聊都复用它；
- 所有绑定用户看到同一条消息流，而不是只看到自己的提问和回答；
- 不需要二维码、扫码绑定、公网 webhook 或内网穿透；
- 只有一个设置页：App ID、App Secret、Session、连接状态和测试消息。

## 功能范围（MVP）

- 飞书企业自建应用，官方 Node SDK `1.76.0` 的 WebSocket 长连接；
- 入站支持单聊 `text` 与 `post` 文本；
- 助手最终回复使用**卡片 JSON 2.0 的 `markdown` 富文本组件**渲染，卡片标题保留 `[助手]` 标识；长回复按段落/代码围栏边界分片，多条时标注 `(i/n)`；
- 其它镜像消息（飞书用户消息、DSH 网页人类输入的 `[DSH]`、测试消息）保持纯文本 `text`，不把用户随手输入当 Markdown 渲染；
- 首次单聊自动保存 `open_id + chat_id` 绑定；
- 飞书输入以 `[飞书 · 发送者]` 前缀进入所选 Session；
- DSH 网页中的人类输入以 `[DSH]` 前缀同步；
- 每个 turn 的最后一条非空、未中断正式助手消息，仅在 `turn/end.reason` 为 `completed` 后广播一次；取消、失败、受阻和 `max-tokens` 截断的 turn 不广播；
- `message_id + event_id` 双键持久去重、Session 事件去重、机器人消息防回环；
- 全局 FIFO、指数退避、发送 API `uuid` 幂等、SDK 自动 tenant token 刷新；
- 一个收件人失败不阻塞其他收件人，绑定保留以便重新加回机器人后恢复；
- Secret 存入 DSH credentials；状态接口、设置页和日志不返回明文。

明确不做：群聊、图片/文件/音视频、交互式卡片按钮/卡片审批、流式 token、工具进度、消息编辑/撤回、二维码流程、多机器人、多实例高可用。子 Agent Session 也不在选择范围内。

## 从飞书开放平台开始

1. 在[飞书开放平台](https://open.feishu.cn/)创建**企业自建应用**。
2. 在“应用能力”中启用**机器人**。
3. 在“权限管理”申请最小权限：
   - `im:message.p2p_msg:readonly`：接收单聊用户消息；
   - `im:message:send_as_bot`：以机器人身份发送消息。

   `im:message` 是更宽的替代权限，不是本 MVP 必须同时申请的权限。群聊的 `group_at_msg` 等权限目前不需要。
4. 在“事件订阅”中添加**接收消息 v2.0**（`im.message.receive_v1`），订阅方式选择**使用长连接接收事件**。如果后台保存长连接方式时要求已有在线连接，先完成下面的 DSH 安装并点击“连接”，保持连接后再保存。
5. 按企业要求创建并发布应用版本，等待权限和事件配置生效。将机器人加入你的飞书联系人/可用范围；MVP 只需私聊机器人。

官方依据：[长连接配置](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)、[接收消息事件与权限](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[发送消息 API](https://open.feishu.cn/document/server-docs/im-v1/message/create)。

## 安装到 DSH

目标安装版：**DSH `0.2.2-rc.5`**，Node.js `>=24.9`，pnpm `12.x`。

```bash
git clone https://github.com/yankeguo/dsh-feishu-omni.git
cd dsh-feishu-omni
pnpm install
pnpm build
```

必须先执行上述安装和构建命令：`lib/` 被 `.gitignore` 排除，全新 clone 不含构建产物；不构建会在插件激活时因无法 import `lib/index.js` 而失败。

然后在 DSH 中打开 **Plugins → Add plugin**，在插件 **spec 文本框**中粘贴这个仓库目录的**绝对路径**（例如 `/Users/name/dsh-feishu-omni`），不要使用相对路径；这个版本没有目录选择器。该目录的 `package.json` 同时声明 Host bundle 与 Web Client；不要运行另一个 DSH 或 Web 服务。

首次安装可能因 `@larksuiteoapi/node-sdk` 的传递依赖 `protobufjs` 报 `ERR_PNPM_IGNORED_BUILDS`，安装对话框会显示“有依赖的安装脚本需要你允许后才能继续”并列出待批准的脚本。点击**“允许这些脚本并重试”**即可继续；不要为此修改依赖版本。

### 配置

打开 **Settings → 飞书 Omni**，或在 **Plugins** 中打开本插件的配置页：

1. 填飞书官方术语所示的 **App ID / App Secret**。Secret 输入框遮罩；保存后输入框清空，留空表示保留已保存 Secret。
2. 点击刷新，从列表选择一个普通 DSH Session。列表包含已加载和持久化的冷 Session，排除 `origin: subagent`。
3. 保存配置，点击**连接**。状态会显示连接中、已连接或最近错误；点击连接时就会记住自动连接，因此即使本次连接随后失败，下次启动 DSH 也会重试。
4. 让第一位飞书用户私聊机器人一句话，自动建立绑定。之后可用“发送测试消息”检查所有绑定用户的投递。
5. 其他用户分别私聊机器人，即加入同一个共享消息流。

“断开”会关闭长连接并禁用下次启动时的自动连接；凭据和绑定不会删除。

## 本地开发

```bash
pnpm install
pnpm run lint
pnpm run typecheck
pnpm test
pnpm build
# 或一次执行全部检查
pnpm run verify
```

测试全部使用 fake 飞书网关、fake Session 和临时目录，不需要真实凭据。CI 在 Node 24 上执行同一组检查。

## 消息示例

```text
[飞书 · 用户 ou_ab…1234]
请修复这个失败测试

[飞书 · 张三]            # 只有事件本身提供姓名时才使用姓名
这个测试在 CI 上也会失败

[DSH]
我补充一下本地复现步骤

[助手]
已定位到共享队列的竞态……
```

飞书消息事件通常不携带用户姓名，因此默认使用缩短的 Open ID，不额外申请通讯录权限。

## 出站消息格式

| 消息 | 飞书消息类型 | 说明 |
| --- | --- | --- |
| 助手最终回复 | `interactive`（卡片 JSON 2.0） | 卡片标题 `[助手]`；一个 `markdown` 元素承载回复原文；多条时标题为 `[助手] (i/n)` |
| 飞书用户消息镜像、`[DSH]` 人类输入、测试消息 | `text` | 纯文本，避免把用户随手输入按 Markdown 解释 |

助手卡片出站 `content` 的结构（序列化为 JSON 字符串后发送）：

```json
{
  "schema": "2.0",
  "header": {
    "title": { "tag": "plain_text", "content": "[助手] (1/2)" },
    "template": "blue"
  },
  "body": {
    "elements": [{ "tag": "markdown", "content": "## 标题\n\n- 列表项\n\n```ts\nconst x = 1\n```" }]
  }
}
```

- **渲染能力**：标题、加粗/斜体/删除线、链接、有序/无序列表、引用、代码块（含语言）、表格、分割线等由飞书客户端原生渲染。按官方文档，卡片 JSON 2.0 的 `markdown` 组件单卡最多 4 个表格、整卡最多 200 个元素（本插件每卡只用 1 个元素）。
- **分片**：按**最终 HTTP 请求体**估算，每条消息 ≤ **24 KB**（飞书卡片/富文本消息请求体上限 30 KB，预留 1 KB 给卡片包装与请求信封）。预算计入 markdown 的**二次 JSON 转义**——markdown 先转义进卡片 JSON，卡片 JSON 再转义为消息 `content`，引号/反斜杠密集的文本最多膨胀到 4 倍；分片实现按二次转义后的字节数计算，并用确定性随机长文本用例与本地 fuzz（300 组随机/病态文本）验证模拟请求体最大 23.3 KB。分片优先在段落边界切；代码围栏不会被打断（超长代码块会先闭合围栏，再在下一条用相同语言标记重新打开），单行超长时按字符边界硬切。每片的 `uuid` 由「Session 事件键 + chat_id + 分片序号」确定性派生，重试幂等、分片不重复。
- **顺序与限频**：同一收件人的分片串行、按序发送；飞书限频（官方文档：同一用户约 5 QPS、应用全局 1000 次/分）命中 429/`230020`/旧接口 `400+99991400` 时沿用指数退避，不并行发送。
- **回退**：卡片被飞书明确拒绝（例如 `230099` 卡片内容非法、`230025` 消息体超长）时，用**同一个 uuid** 回退为纯文本 `[助手] …`，尽量保证消息不丢；网络超时等「结果不确定」的情况先用同一 uuid 重试，仍不确定时也用同一 uuid 回退纯文本——飞书文档规定相同 uuid 在 1 小时内至多成功发送一条消息，因此不会与可能已落地的卡片重复。该不重复保证依赖平台幂等语义，属 best effort；回退本身也失败时该收件人停止剩余分片并上报错误。`230002`（机器人不在会话）等永久错误不重试、也不回退为文本。
- **旧客户端降级**：卡片 JSON 2.0 需要飞书客户端 **7.20 及以上**。按官方文档，低于 7.20 时标题仍显示、正文显示官方的“升级客户端”提示文案，而不会把列表/代码块降级成纯文本（真实旧客户端表现需人工验收）。这是选择 2.0 的固有代价（2.0 才支持列表、代码块和表格）。
- **权限**：仍只需要 `im:message.p2p_msg:readonly` 与 `im:message:send_as_bot`。`msg_type=interactive` 与 `text` 使用同一个发送消息接口，不需要新增权限；真实租户下的首次卡片发送请在人工验收中确认。

## 持久化与隐私

- 非秘密配置、绑定和最近去重键：`$DSH_HOME/integrations/dsh-feishu-omni/state.json`（未设置 `DSH_HOME` 时为 `~/.dsh/...`）。写入采用临时文件原子替换，文件权限 `0600`。读取时只把**内容损坏**（JSON 解析失败，或 schema/版本/绑定校验失败）的 `state.json` 改名为旁边的 `state.json.corrupt-*`，以空状态启动，设置页的最近错误会显示恢复信息，原文件不会直接删除。其它读 I/O 错误（如权限不足 EACCES）、非普通文件、超过 1 MiB 的文件不会被旁置或覆盖：插件初始化直接报错，文件保持原样，需要人工检查；旁置本身失败也按错误上抛，不会以空状态继续。
- App Secret：DSH credentials 引用 `DSH_FEISHU_OMNI_APP_SECRET`，由本机 DSH credential provider 保存。
- 管理 RPC 复用 DSH 已认证的 `/api` 通道，不新增端口，不读取或重写 profile 的 `cordis.patch.yml`。
- 仓库、测试夹具、状态响应和插件日志均不应包含真实 Secret。

## 人工验收（需要真实飞书应用）

自动测试不访问真实飞书，也不安装到当前运行中的 DSH。请人工执行：

- [ ] `pnpm install && pnpm run verify` 全部通过。
- [ ] 在全新 clone 中先执行 `pnpm install && pnpm build`，确认生成 `lib/`，再在 Add plugin 的 spec 文本框粘贴仓库绝对路径。
- [ ] 首次安装若出现 `ERR_PNPM_IGNORED_BUILDS`，安装对话框列出待批准脚本，点击“允许这些脚本并重试”后安装能够继续。
- [ ] Add plugin 后，插件条目显示名称、说明和图标，无加载错误。
- [ ] 独立 Settings 页面和 Plugin Manager 的 Configure 页面均可打开。
- [ ] 保存无效凭据时出现可理解错误，页面和日志没有 Secret 明文。
- [ ] 保存有效凭据并选择 DevLead lead Session 后，状态变为已连接。
- [ ] 飞书后台可以选择长连接并保存 `im.message.receive_v1` 订阅。
- [ ] 用户 A 私聊后，A 的绑定出现；用户 B 私聊后，A 也能看到 B 进入 Session 的消息。
- [ ] DevLead 的最终回复同时到达 A、B；工具调用和流式 token 不刷屏；取消、失败或 `max-tokens` 截断的 turn 不广播半截回复。
- [ ] **助手回复的 Markdown 在飞书内正确渲染**：标题、加粗、列表、代码块（含语言高亮）、链接、表格；卡片标题显示 `[助手]`。
- [ ] 让助手输出一段很长（例如超过 30 KB）的回复（多个段落 + 长代码块 + 引号密集文本），确认被拆成多条 `[助手] (i/n)` 卡片、顺序正确、代码围栏在分片处正确闭合/重开，没有半截代码块。
- [ ] 用低于飞书客户端 7.20 的旧版打开助手卡片：确认标题仍在、正文显示升级提示（已知限制，不会降级为纯文本 Markdown）。
- [ ] 同一消息重复投递不会重复进入 Session；网页中的人类输入也会同步。
- [ ] 断网再恢复后 SDK 自动重连；终态错误可在设置页查看并手动重新连接。
- [ ] 一个会话投递失败不妨碍另一个会话，恢复后下一条消息可再次送达。
- [ ] 断开后飞书消息不再进入 Session，重新连接后恢复。

首次本地目录安装可能通过插件 HMR 生效。**替换已安装包需要重启 DSH**；本仓库的自动验证不会替你重启桌面应用。助手卡片改动同样需要 `pnpm build` 后重启 DSH 才能在运行中的 Host 进程里生效。

## 设计、限制与调查依据

见 [`docs/DESIGN.md`](docs/DESIGN.md)，包括 DSH `0.2.2-rc.5` 的实际 API、消息流、去重/防环、DevLead 取舍、崩溃边界及未验证项。

## License

MIT，见 [`LICENSE`](LICENSE)。
