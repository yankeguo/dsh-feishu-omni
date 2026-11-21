# dsh-feishu-omni

[![verify](https://github.com/yankeguo/dsh-feishu-omni/actions/workflows/verify.yml/badge.svg)](https://github.com/yankeguo/dsh-feishu-omni/actions/workflows/verify.yml)

把一个**既有 DeepSeek Harness（DSH）Session**变成飞书里的共享指挥频道：多位飞书用户向同一个机器人发言，消息进入同一个 Session；该 Session 的人类输入和助手最终回复再广播给所有已绑定用户，但飞书用户消息不回显给发送者本人。助手最终回复使用飞书卡片渲染 Markdown（标题、列表、代码块、链接、表格），而不是把 Markdown 当纯文本显示。机器人会在消息成功进入 Session 后给原消息加一个固定的 `OK` 表情作为送达回执。

图片和文件双向可用：飞书用户可以直接发图片/文件，图片以 DSH **原生 ImageBlock**、文件以**原生 FileBlock（只读绝对路径）**进入 Session，助手用现有 `Read`/`read_image`/office 工具就能看和读；助手也能在卡片里内联显示图片，或用现有 `present` 工具把文件/图片作为交付物发回飞书。**不新增任何 agent tool。**

主要用途是配合 **DevLead**：团队成员在同一个 lead Session 中发言，看到彼此进入对话的消息以及 DevLead 的最终回复。

> **安全提示：这是共享控制面，不是只读群聊。** 任何在飞书应用可用范围内、能私聊该机器人的用户，首次发言都会被绑定，并能向所选 Session 提交指令。请限制企业自建应用的可用范围，并只绑定你信任这些用户共同操作的 Session。出站上传（`present` 交付物与卡片内联图片）只允许读取**绑定 Session 的工作目录**或 **DSH 附件目录**内的文件：路径先做 `realpath` 收敛，再用严格前缀判定边界，目的正是防止 prompt 注入把本机任意文件外发到所有绑定飞书用户；工作区外的文件请让 agent 先复制进工作区。

## 与常见 IM 插件的区别

常见的 DSH IM 接入（包括参考实现 [`xmanrui/dsh-im`](https://github.com/xmanrui/dsh-im)）通常按 IM 用户/会话创建独立 DSH Session。本插件刻意采用相反模型：

- 只选择一个已经存在的普通 DSH Session，不自动创建 Session；
- 所有飞书单聊都复用它；
- 所有绑定用户共享同一条消息流，而不是只看到自己的提问和回答（发送者不回显自己刚发的消息，见[回显抑制与表情回执](#回显抑制与表情回执)）；
- 不需要二维码、扫码绑定、公网 webhook 或内网穿透；
- 只有一个设置页：App ID、App Secret、Session、连接状态和测试消息。

## 功能范围（MVP）

- 飞书企业自建应用，官方 Node SDK `1.76.0` 的 WebSocket 长连接；
- 入站支持单聊 `text`、`post` 文本，以及 `image`、`file`、`audio`、`media` 消息和 `post` 富文本里的 `img` 节点；
- 入站图片经下载、魔数嗅探（PNG/JPEG/WEBP/GIF）后交给 DSH 附件服务暂存，在 Session 中成为**原生 ImageBlock**；文件/音频/视频流式写入 DSH 附件服务，成为**原生 FileBlock**（只读绝对路径），助手用现有工具读取；
- 出站交付物：监听 `deliverables/presented` 会话事件，`turn/end` 为 `completed` 时先发助手卡片、再按绑定发送文件/图片消息；
- 出站内联图片：最终回复里的本地 Markdown 图片引用上传为飞书 `image_key` 后改写进卡片，直接显示图片；`present` 已声明的同一图片不重复显示；
- 图片/文件镜像沿用文本镜像的可见性规则：除发送者外的绑定用户可见，发送者不回显；可重试错误先按指数退避重试，重试耗尽或永久错误才降级为占位文本；
- 助手最终回复使用**卡片 JSON 2.0 的 `markdown` 富文本组件**渲染，卡片标题保留 `[助手]` 标识；长回复按段落/代码围栏边界分片，多条时标注 `(i/n)`；
- 其它镜像消息（飞书用户消息、DSH 网页人类输入的 `[DSH]`、测试消息）保持纯文本 `text`，不把用户随手输入当 Markdown 渲染；
- 首次单聊自动保存 `open_id + chat_id` 绑定；
- 飞书输入以 `[飞书 · 发送者]` 前缀进入所选 Session；
- 飞书用户消息的镜像广播排除发送方本人（按绑定 `chat_id` 匹配）：发送者不再收到自己刚发内容的重复回显，其他绑定用户仍能看到；`[DSH]` 人类输入和助手最终回复仍广播给全部绑定用户；
- 消息成功投递到绑定 Session（prompt admission 成功且去重键已持久化）后，机器人给飞书原始消息加一个固定 `OK` 表情作为送达回执；这是 best effort，失败只记日志，不影响消息投递与广播；
- DSH 网页中的人类输入以 `[DSH]` 前缀同步；
- 每个 turn 的最后一条非空、未中断正式助手消息，仅在 `turn/end.reason` 为 `completed` 后广播一次；取消、失败、受阻和 `max-tokens` 截断的 turn 不广播；
- `message_id + event_id` 双键持久去重、Session 事件去重、机器人消息防回环；
- 全局 FIFO、指数退避、发送 API `uuid` 幂等、SDK 自动 tenant token 刷新；
- 一个收件人失败不阻塞其他收件人，绑定保留以便重新加回机器人后恢复；
- Secret 存入 DSH credentials；状态接口、设置页和日志不返回明文。

明确不做：群聊、交互式卡片按钮/卡片审批、流式 token、工具进度、消息编辑/撤回、二维码流程、多机器人、多实例高可用、附件自动清理、>100 MB 资源下载（飞书需要 Range 分片）、音频/视频的内联播放。表情回复只做固定 `OK` 的送达回执，不做自定义表情、表情统计或删除。子 Agent Session 也不在选择范围内。

> 本功能的硬约束：**不新增任何 agent tool（不新增 DSH tool / MCP tool）**。入站复用 DSH 的附件服务与原生 ImageBlock/FileBlock，出站复用 agent 已有的 `present` 工具与助手 Markdown 引用。

## 从飞书开放平台开始

1. 在[飞书开放平台](https://open.feishu.cn/)创建**企业自建应用**。
2. 在“应用能力”中启用**机器人**。
3. 在“权限管理”申请权限。图片/文件功能的最小权限组合是五项：
   - `im:message.p2p_msg:readonly`：接收单聊用户消息；
   - `im:message:send_as_bot`：以机器人身份发送消息（含 `image`/`file` 消息）；
   - `im:message.reactions:write_only`：给用户原始消息添加 `OK` 表情回执；
   - `im:message:readonly`：下载用户消息里的图片/文件资源（任一即可：`im:message` / `im:message:readonly` / `im:message.history:readonly`）；
   - `im:resource:upload`：上传图片/文件（任一即可：`im:resource` / `im:resource:upload`）。

   只想要文本功能时，前三项即可；图片/文件功能需要后两项。

   `im:message`（获取与发送单聊、群组消息）是更宽的权限。按官方文档的“开启任一权限即可”关系，[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)可用 `im:message` 替代 `im:message:send_as_bot`，[添加消息表情回复](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)可用 `im:message` 替代 `im:message.reactions:write_only`，[获取消息中的资源文件](https://open.feishu.cn/document/server-docs/im-v1/message-resource/get)可用 `im:message` 替代 `im:message:readonly`；但[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)的单聊权限仍按官方文档使用 `im:message.p2p_msg:readonly`，上传资源则需要独立的 `im:resource`/`im:resource:upload`。也就是说 `im:message.p2p_msg:readonly` + `im:message` + `im:resource:upload` 三项也可以工作。群聊的 `group_at_msg` 等权限目前不需要。
4. 在“事件订阅”中添加**接收消息 v2.0**（`im.message.receive_v1`），订阅方式选择**使用长连接接收事件**。如果后台保存长连接方式时要求已有在线连接，先完成下面的 DSH 安装并点击“连接”，保持连接后再保存。
5. 按企业要求创建并发布应用版本，等待权限和事件配置生效。将机器人加入你的飞书联系人/可用范围；MVP 只需私聊机器人。**权限变更必须创建并发布新应用版本才生效**：`im:message.reactions:write_only`、`im:message:readonly` 与 `im:resource:upload` 都需要这一步。缺权限时不影响文本链路：
   - 缺 `im:message.reactions:write_only`：没有 `OK` 回执，日志出现可辨识权限警告（见[表情回复 ack](#表情回复-ack)）；
   - 缺 `im:message:readonly`：用户发来的图片/文件无法下载，发言人收到明确降级提示、Session 不收到该附件，文本消息与助手卡片完全正常；
   - 缺 `im:resource:upload`：其他绑定用户的图片/文件镜像与出站交付物降级为占位/文本提示，入站 prompt 与助手卡片不受影响。

官方依据：[长连接配置](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)、[接收消息事件与权限](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[发送消息 API](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[添加消息表情回复 API](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)、[表情文案说明](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce)。

## 安装到 DSH

目标安装版：**DSH `0.2.2-rc.5`**（`engines.dsh` = `>=0.2.2-rc.5 <0.3.0`），Node.js `>=24.9`，pnpm `12.x`。

### 从 npm 安装（0.1.0 approve 之后）

`0.1.0` 是首个稳定版：`v0.1.0` tag 触发 CI **只 stage、不发布**，维护者在 npmjs.com 网页 approve 后版本才会公开；approve 后 `latest` 指向 `0.1.0`。

```bash
dsh plugin --profile desktop add @yankeguo/dsh-feishu-omni@0.1.0
# 或省略版本（approve 后 latest 即 0.1.0）：
dsh plugin --profile desktop add @yankeguo/dsh-feishu-omni
```

也可以在 Web 的 **Plugins → Add plugin** 中输入 `@yankeguo/dsh-feishu-omni`。

> **首发前 npm 上不存在该包**（`npm view` 返回 404）：此时请用下面的“从源码目录安装”。新包首次发布需要维护者先做一次性 bootstrap（手工发布 `0.0.0-stage` 探针版本 → 配置 npm trusted publisher），之后 `v0.1.0` tag 才能由 CI stage。完整流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

### 从源码目录安装（首次发布、日常开发）

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
# 或一次执行全部检查（lint + typecheck + test + build）
pnpm run verify
# 单包发布不变式（manifest/engines/files/exports/locale/icon/依赖放置/构建产物/lockfile/CI pin）
pnpm run check:packages
# 本地打包 + npm stage 预检（不上传、不创建 stage id；需要 npm >= 11.20.0）
pnpm run release:dry
```

测试全部使用 fake 飞书网关、fake Session 和临时目录，不需要真实凭据。CI 在 Node 24 上执行同一组检查。

## CI 与发布

- [`verify.yml`](.github/workflows/verify.yml)：push 到 main、PR（以及手动 dispatch）触发；`pnpm install --frozen-lockfile` → `pnpm run verify` → `pnpm run check:packages`。只读权限，不接触 registry。
- [`publish.yml`](.github/workflows/publish.yml)：推送 `v*` tag（或用 workflow_dispatch 指定一个**已存在**的 tag）触发；先校验 tag 指向当前 commit、`v<version>` 与根 `package.json` 版本一致，再 install/typecheck/test/build/`check:packages`，最后用 `node scripts/stage-release.mjs` **只 stage、不发布**。稳定版 dist-tag `latest`；预发布（如 `v0.1.0-rc.1`）`next` 且绝不允许 latest。使用 GitHub OIDC trusted publishing（无长期 npm token）并生成 provenance。
- 发布 = tag push → CI stage（此时什么都还没公开）→ 维护者在 **npmjs.com 网页**批量 approve（登录 + 2FA，一次 2FA 可批准一批）→ approve 后由维护者/被通知的 agent **手动**创建 GitHub Release：`gh release create v0.1.0 --repo yankeguo/dsh-feishu-omni --title v0.1.0 --notes-file docs/releases/v0.1.0.md --verify-tag --latest`（预发布用 `--prerelease --latest=false`）。CI 永不创建、移动或删除 tag，也不创建 Release。
- **新包首次发布需要维护者一次性 bootstrap**：npm trusted publishing 要求包已存在，因此必须先手工发布探针版本 `0.0.0-stage` 并配置 trusted publisher，之后 `0.1.0` 才能由 CI stage。命令、rc 规则、故障排查见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 消息示例

```text
[飞书 · 用户 ou_ab…1234]
请修复这个失败测试

[飞书 · 张三]            # 只有事件本身提供姓名时才使用姓名
这个测试在 CI 上也会失败

[飞书 · 李四]
（图片）                 # 图片以原生 ImageBlock 进入 Session，文本只带占位

[飞书 · 王五]
（文件：需求.pdf）        # 文件以原生 FileBlock 进入 Session，agent 用只读路径读取

[DSH]
我补充一下本地复现步骤

[助手]
已定位到共享队列的竞态……
```

飞书消息事件通常不携带用户姓名，因此默认使用缩短的 Open ID，不额外申请通讯录权限。

发送者本人不会收到自己这条消息的镜像回显，其他绑定用户仍会看到；图片/文件也遵循同一规则（发送者不回显，其他绑定用户收到重新上传的图片/文件消息）；`[DSH]` 人类输入与助手回复的广播不受影响。回显抑制的具体语义与兜底见后文[回显抑制与表情回执](#回显抑制与表情回执)，附件链路见[图片与文件](#图片与文件)。

## 回显抑制与表情回执

### 发送者不回显

飞书用户消息进入共享 Session 后，其 `user/message` 镜像按**发送方 chat 排除**该消息的发送者：

| 消息 | 广播范围 |
| --- | --- |
| 飞书用户消息镜像 | 除发送方外的全部绑定用户；发送者本人不回显 |
| 飞书用户图片/文件镜像 | 除发送方外的全部绑定用户；二次上传失败时用 `[图片]`/`[文件: name]` 占位文本 |
| DSH 网页人类输入的 `[DSH]` | 全部绑定用户 |
| 助手最终回复 | 全部绑定用户，渲染方式不变（见[出站消息格式](#出站消息格式)） |

这是可见性优化，不是把共享频道改成私聊：其他绑定用户仍能看到这条消息，助手回复仍广播给所有人。实现上，飞书 prompt 的 `requestId` 形如 `feishu-omni:<message_id>:<chat_id>`，DSH 将其原样记入持久 `user/message.source.rpcId`，出站侧从 Session 事件即可解析发送方，不依赖内存映射表。**兜底口径：可见性优先，宁可偶发一次回显，绝不丢失其他用户的可见性。**

- `rpcId` 不以 `feishu-omni:` 开头：按 `[DSH]` 处理，全量广播（行为与之前一致）；
- 以 `feishu-omni:` 开头但解析不出 `chat_id`（旧版本插件提交的旧格式 `feishu-omni:<message_id>`）：全量广播。因此升级后首次重放或延迟接纳旧消息时可能偶发一次回显，正常新消息不会；
- 解析出的 `chat_id` 不在当前绑定列表（绑定已刷新或删除）：没有可排除对象，等价全量广播；
- 发送者的绑定在 prompt 与事件之间被刷新（`chat_id` 变化）：同走全量广播。

### 表情回复 ack

消息成功进入绑定 Session 后，机器人会给**用户原始消息**添加一个固定的 `OK` 表情（飞书 `emoji_type=OK`）：

- **时机**：仅在 prompt admission 成功、且去重键已持久化之后，对原始 `message_id` 调用[添加消息表情回复](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)（`POST /open-apis/im/v1/messages/:message_id/reactions`，body `{"reaction_type":{"emoji_type":"OK"}}`）。
- **一次尝试、不重试**：5 秒有界超时并随 bridge 生命周期取消；任何失败只记日志，绝不影响消息投递与广播。
- **不会加表情**：事件被忽略（群聊/机器人/不支持的消息类型/空文本）、`message_id` 或 `event_id` 去重命中（重复投递）、prompt 最终投递失败（此时仍保留原有的「消息暂时无法投递」提示）。
- **失败表现**：缺权限、限频、消息已撤回、系统消息、网络/超时等只写日志，并在**首次出现或错误类别变化**时记一条 warning、恢复后记一条 info（避免每条消息刷屏）。warning 附带脱敏后的摘要 `code=<飞书业务码> status=<HTTP status> msg=<飞书 msg>`（如 `code=231022 status=400 msg=...`，缺失项省略），因此撤回消息（`231003`）与用户不在可用范围（`231022`）等同类失败可以从日志区分；摘要不含请求体、消息正文、URL 查询参数或凭据。ack 失败不写入 Settings 的连接状态/最近错误，不会被误报成连接故障。
- **平台限制**（官方文档）：消息已撤回后无法添加表情回复；系统消息（`system`）无法添加；接口频率限制为 1000 次/分钟、50 次/秒。
- **所需权限**：`im:message.reactions:write_only`，或更宽的 `im:message`。新增权限后必须在飞书开放平台**发布新应用版本**才生效；未添加时消息流完全正常，只是没有 `OK` 回执，日志出现可辨识的权限警告。

`OK` 是官方[表情文案说明](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce)中的合法 `emoji_type`。错误分类、日志节流与回显抑制的实现细节见 [`docs/DESIGN.md`](docs/DESIGN.md) 第 10 节。

## 出站消息格式

| 消息 | 飞书消息类型 | 说明 |
| --- | --- | --- |
| 助手最终回复 | `interactive`（卡片 JSON 2.0） | 卡片标题 `[助手]`；一个 `markdown` 元素承载回复原文；多条时标题为 `[助手] (i/n)`；本地图片引用会先改写为飞书 `image_key` 内联显示 |
| 飞书用户消息镜像、`[DSH]` 人类输入、测试消息 | `text` | 纯文本，避免把用户随手输入按 Markdown 解释 |
| 入站图片镜像 | `image` | `content={"image_key":"..."}`；每个收件 chat 独立确定性 uuid |
| 入站文件/音频/视频镜像 | `file` | `content={"file_key":"..."}`；`file_type` 按扩展名映射，音频/视频用 `stream` |
| 出站交付物（present）图片 | `image` | 上传一次、跨绑定复用 `image_key`；超过 10 MB 先经 DSH 规范化 |
| 出站交付物（present）文件 | `file` | 上传一次、跨绑定复用 `file_key`；≤30 MB，`file_type=pdf/doc/xls/ppt/stream` |

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
- **分片**：按**最终 HTTP 请求体**估算，每条消息 ≤ **24 KB**（飞书卡片/富文本消息请求体上限 30 KB，预留 1 KB 给卡片包装与请求信封）。预算计入 markdown 的**二次 JSON 转义**——markdown 先转义进卡片 JSON，卡片 JSON 再转义为消息 `content`，引号/反斜杠密集的文本最多膨胀到 4 倍；分片实现按二次转义后的字节数计算，并用确定性随机长文本用例与本地 fuzz（300 组随机/病态文本）验证模拟请求体最大 23.3 KB。分片优先在段落边界切；被识别为代码围栏的块不会被打断（超长代码块会先闭合围栏，再在下一条用相同语言标记重新打开）。围栏识别沿用 CommonMark 的 0–3 空格缩进规则：4 空格缩进或引用块（`>`）内的围栏不会被当作围栏，这类内容在分片边界可能被拆开、跨卡片渲染不完美（内容不会丢失），详见 [已知限制](docs/DESIGN.md)。单行超长时按字符边界硬切。每片的 `uuid` 由「Session 事件键 + chat_id + 分片序号」确定性派生，重试幂等、分片不重复。
- **顺序与限频**：同一收件人的分片串行、按序发送；飞书限频（官方文档：同一用户约 5 QPS、接口 1000 次/分与 50 次/秒）命中 429/`230020`/`11232`/`11233`/`11247`/旧接口 `400+99991400` 时沿用指数退避，不并行发送。
- **回退**：卡片被飞书明确拒绝（例如 `230099` 卡片内容非法、`230025` 消息体超长）时，用**同一个 uuid** 回退为纯文本 `[助手] …`，尽量保证消息不丢；网络超时等「结果不确定」的情况先用同一 uuid 重试，仍不确定时也用同一 uuid 回退纯文本——飞书文档规定相同 uuid 在 1 小时内至多成功发送一条消息，因此不会与可能已落地的卡片重复。该不重复保证依赖平台幂等语义，属 best effort；回退本身也失败时该收件人停止剩余分片并上报错误。`230002`（机器人不在会话）等永久错误不重试、也不回退为文本。
- **旧客户端降级**：卡片 JSON 2.0 需要飞书客户端 **7.20 及以上**。按官方文档，低于 7.20 时标题仍显示、正文显示官方的“升级客户端”提示文案，而不会把列表/代码块降级成纯文本（真实旧客户端表现需人工验收）。这是选择 2.0 的固有代价（2.0 才支持列表、代码块和表格）。
- **权限**：卡片和文本都走发送消息接口，`im:message:send_as_bot`（或更宽的 `im:message`）即可覆盖 `msg_type=interactive`，卡片路径本身没有新增权限。本次发布为表情回执新增 `im:message.reactions:write_only`（或复用 `im:message`），与卡片无关，见[表情回复 ack](#表情回复-ack)。真实租户下的首次卡片发送与表情回执请在人工验收中确认。

## 图片与文件

图片与文件复用 DSH 与飞书已有能力，**没有新增任何 agent tool**：入站走 DSH 附件服务 + 原生 `ImageBlock`/`FileBlock`，出站走 agent 已有的 `present` 工具与助手 Markdown 引用。

### 入站（飞书 → Session）

- 支持单聊 `image`、`file`、`audio`、`media` 消息，以及 `post` 富文本里的 `img`（图片）与 `media`（视频）节点；群聊仍不支持。
- **图片**：`GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image` 下载（插件上限 20 MB）→ 按文件头魔数识别 PNG/JPEG/WEBP/GIF（其它格式不接受，HEIC/BMP/TIFF/SVG 会收到明确提示）→ DSH `ctx.fileUploads.uploadImageStream` 暂存并规范化 → prompt 以 receipt 引用 → DSH 把它变成**原生 ImageBlock**。模型是否支持视觉由 DSH 在 admission 时检查；不支持时返回 `MODEL_DOES_NOT_SUPPORT_IMAGES`，插件给发送者发文本提示且不加 `OK` 回执。
- **文件/音频/视频**：同一资源接口 `type=file`，流式写入 DSH `ctx.fileUploads.uploadStream`（上限 100 MB，即飞书单次下载上限）→ **原生 FileBlock**。DSH 在请求装配时把 FileBlock 投影成带**只读绝对路径**的文本句柄，agent 用现有 `Read`/`Bash`/office/`read_image` 工具处理，不需要新工具。
- prompt 文本保留 `[飞书 · 发送者]` 前缀，并附占位：`（图片）`、`（文件：name）`、`（音频）`、`（视频：name）`。
- 附件字节不经过插件自管目录，也不进日志：DSH 附件服务负责命名净化、去重与内容寻址（`$DSH_HOME/attachments/v1`，未设置 `DSH_HOME` 时为 `~/.dsh/attachments/v1`）。
- 可见性与文本镜像一致：已下载的图片/文件会重新上传成 `msg_type=image`/`file` 发给**除发送者外**的所有绑定 chat；发送者不回显；可重试错误先按指数退避重试，重试耗尽或永久错误才降级为 `[图片]`/`[文件: name]` 文本，失败只记日志。
- **镜像副本预算**：一条消息内所有入站附件保留的原始镜像副本共享 **60 MB** 预算（`MAX_INBOUND_MIRROR_BYTES`），避免为镜像把几十 MB 的附件字节都留在内存里。多张大图/大文件可能先用满预算，随后的附件就拿不到原始副本：文件镜像降级为 `[文件: name]` 占位文本，图片若 DSH 已返回规范化副本则改用它重传，仍不可用才降级为 `[图片]`；DSH 侧的 prompt 附件与文本消息不受影响。

### 出站（Session → 飞书）

> 出站交付物依赖绑定 Session 的 agent preset 挂载了 `present` 工具（标准 preset 默认挂载；minimal preset 可能没有）。没有 `present` 时，助手仍可用 Markdown 图片引用内联显示图片。

- **交付物（present）**：agent 现有的 `present` 工具在工具成功时 append 只读事件 `deliverables/presented`（`{turn, files:[{path, description?}]}`，无 `surfaceOp`）。插件按 turn 缓冲；`turn/end` 为 `completed` 时**先发助手卡片，再发交付物附件**：
  - 图片（PNG/JPEG/WEBP/GIF，飞书上限 10 MB；超限时先用 DSH `attachments.saveImage` 规范化）→ `msg_type=image`；
  - 其他文件（≤30 MB）→ `msg_type=file`，`file_type` 按扩展名映射为 `pdf`/`doc`/`xls`/`ppt`，其余为 `stream`；音频/视频也按 `stream` 发文件消息（飞书要求 `file_type` 与 `msg_type` 匹配，230055）。
  - 每个文件只上传一次，跨 chat 复用 key；每个 chat 每个文件的 uuid 由「turn 事件键 + chat_id + 文件序号」确定性派生。
  - 文件缺失/为空/超限/上传失败 → 该 chat 收到文本降级（只含文件名、大小与原因，**不带本机路径**），不影响其他 chat 与其他文件。
- **卡片内联图片**：最终助手回复里形如 `![说明](<path>)` / `![说明](path)` 的本地图片会被上传为飞书 `image_key`，并改写为卡片 markdown 的 `![说明](image_key)` 内联显示。相对路径按 Session 工作目录解析（含 `working-directory/change` 后的新目录）。HTTP(S) URL、已经是 `image_key` 的引用、fenced code block、4 列缩进的代码块（tab 按 4 列 tab stop 展开；引用块/列表容器内的缩进代码也识别）、行内代码、反斜杠转义的 `\![说明](path)`、不存在/非图片/工作区与 DSH 附件目录之外的文件、上传失败的引用都**原样保留**；`present` 已声明过的同一路径不会再内联（避免同一张图显示两次）。纯 Markdown 文件链接（`[说明](<path>)`）不会自动推送，避免刷屏。
- **失败隔离与重试**：同一 turn 先卡片后附件；交付物上传/发送沿用可重试码（限频、超时、5xx）的指数退避与同一 UUID，重试耗尽或永久错误才降级为文本，不影响后续收件人/文件。单 turn 最多交付 32 个 present 文件，超出部分记 warning 并跳过。
- **出站路径范围（防注入外发）**：`present` 交付物与卡片内联图片**只桥接 Session 工作区或 DSH 附件目录内的文件**。相对路径先按 Session 工作目录解析，然后 `realpath` 解析 symlink（并统一大小写），最终真实路径必须严格位于允许根内（等于根，或以 `根 + 路径分隔符` 开头）；symlink 指向根外一律拒绝。允许根是：① 绑定 Session 的 cwd（含 `working-directory/change` 后的新目录）；② DSH 附件目录（优先用 `ctx.attachments` 暴露的根，rc.5 desktop 组合已核对可用；仅非标准/fixture composition 未暴露根时退回 `$DSH_HOME/attachments/v1` 约定兜底，未设置 `DSH_HOME` 时为 `~/.dsh/attachments/v1`，且该兜底不完整复刻 DSH `resolveDshHome` 语义——不展开 `~`、把空白 `DSH_HOME` 当字面值、忽略显式 `dshHome` 配置）。收敛要求**至少一个已知允许根**：cwd 与附件根都不可用时，绝对工作区路径同样会被拒绝（fail closed），不只是相对路径依赖 cwd。根外文件不会被读取或上传：`present` 降级为文本提示（只含文件名、大小与原因，如「文件不在会话工作区或 DSH 附件目录内，未发送」，**不含本机绝对路径**），卡片内联图片保留原 Markdown 文本。**其它位置的文件请让 agent 先复制进 Session 工作区**再 `present`/引用。
- **预期保留原文**：卡片内联图片上传失败、文件不是图片、或该路径已被 `present` 作为图片消息发送（去重）时，卡片会原样保留 `![说明](<path>)` 文本（飞书客户端可能显示为破图/路径文本）；这只是 Markdown 文本，**不含也不会上传本机文件字节**，属于预期行为。

### 大小限制与降级

| 方向 | 类型 | 上限 / 规则 | 超过或失败时 |
| --- | --- | --- | --- |
| 入站 | 图片 | 插件 20 MB（低于 DSH 默认 50 MB）；仅 PNG/JPEG/WEBP/GIF | 向发送者发明确文本提示（格式/大小/下载失败），不 prompt、不加 `OK`；文本消息不受影响 |
| 入站 | 文件/音频/视频 | 100 MB（飞书资源下载上限，插件不使用 Range） | 同上 |
| 入站 | 其他绑定镜像 | 图片 ≤10 MB 直接重传，>10 MB 用 DSH 规范化后的副本；文件 ≤30 MB | 降级为 `[图片]`/`[文件: name]` 文本，仅日志 |
| 出站 | 图片交付物 / 内联图片 | 飞书 ≤10 MB；GIF ≤2000×2000、其他 ≤12000×12000 | >10 MB 或直传被拒时经 DSH `attachments.saveImage` 规范化后重试；仍失败 → 文本降级 / 保留原 Markdown |
| 出站 | 文件交付物 | 飞书 ≤30 MB | 超限或上传失败 → 文本降级 |

降级的所有提示都只包含文件名/类型/大小/原因，不包含本机绝对路径、字节或 Secret。

> 模型是否真的“看懂”图片取决于所选上游模型的视觉能力：DSH 会根据模型的 `inputModalities` 拒绝不支持图片输入的模型，插件随后给发送者发文本提示。附件还**不会自动清理**（见 [`docs/DESIGN.md`](docs/DESIGN.md) 已知限制）。

## 持久化与隐私

- 非秘密配置、绑定和最近去重键：`$DSH_HOME/integrations/dsh-feishu-omni/state.json`（未设置 `DSH_HOME` 时为 `~/.dsh/...`）。写入采用临时文件原子替换，文件权限 `0600`。读取时只把**内容损坏**（JSON 解析失败，或 schema/版本/绑定校验失败）的 `state.json` 改名为旁边的 `state.json.corrupt-*`，以空状态启动，设置页的最近错误会显示恢复信息，原文件不会直接删除。其它读 I/O 错误（如权限不足 EACCES）、非普通文件、超过 1 MiB 的文件不会被旁置或覆盖：插件初始化直接报错，文件保持原样，需要人工检查；旁置本身失败也按错误上抛，不会以空状态继续。
- App Secret：DSH credentials 引用 `DSH_FEISHU_OMNI_APP_SECRET`，由本机 DSH credential provider 保存。
- 附件字节：入站由 DSH 附件服务按内容寻址保存（`$DSH_HOME/attachments/v1`，未设置 `DSH_HOME` 时为 `~/.dsh/attachments/v1`，**永不自动清理**）；出站图片需要规范化时也写入同一服务。插件不建自己的附件目录，日志只记录资源 key / 文件名 / 大小 / 脱敏错误摘要，不记录字节或 Secret；本插件自身的文件系统错误只记错误码（如 `ENOENT`），不记绝对路径（第三方库回传的错误摘要无法完全保证）。
- 出站路径白名单：`present` 交付物与卡片内联图片只读取 Session 工作区或 DSH 附件目录内的普通非空文件（`realpath` 收敛 + 严格前缀边界，symlink 指向根外拒绝；cwd 与附件根都不可用时绝对路径也拒绝，fail closed）；这是为了防止共享 Session 被 prompt 注入后把本机任意文件外发到所有绑定飞书用户。根外文件只出现在降级提示的文件名/大小里，不读取、不上传、不记录绝对路径。
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
- [ ] 用户 A 发一条消息后，A 不会收到自己刚发内容的镜像回显，且 A 的原消息出现 `OK` 表情；用户 B 仍能看到 A 的消息（`[飞书 · 发送者]` + 原文）。A 发出的下一条消息同样不回显。
- [ ] DSH 网页中的人类输入（`[DSH]`）仍广播给 A、B 全部绑定用户；助手最终回复的广播与渲染不变。
- [ ] 未添加 `im:message.reactions:write_only`（或已添加但未发布新应用版本）时，消息仍正常进入 Session 并广播，只是没有 `OK` 表情；日志出现可辨识的权限警告。
- [ ] 表情回执失败（例如缺权限、消息在回执前被撤回）只出现在日志里，不改变 Settings 的连接状态/最近错误，也不影响消息投递与广播。
- [ ] DevLead 的最终回复同时到达 A、B；工具调用和流式 token 不刷屏；取消、失败或 `max-tokens` 截断的 turn 不广播半截回复。
- [ ] **助手回复的 Markdown 在飞书内正确渲染**：标题、加粗、列表、代码块（含语言高亮）、链接、表格；卡片标题显示 `[助手]`。
- [ ] 让助手输出一段很长（例如超过 30 KB）的回复（多个段落 + 长代码块 + 引号密集文本），确认被拆成多条 `[助手] (i/n)` 卡片、顺序正确、代码围栏在分片处正确闭合/重开，没有半截代码块。
- [ ] 用低于飞书客户端 7.20 的旧版打开助手卡片：确认标题仍在、正文显示升级提示（已知限制，不会降级为纯文本 Markdown）。
- [ ] 同一消息重复投递不会重复进入 Session，也不会重复添加表情回执；网页中的人类输入也会同步。
- [ ] 断网再恢复后 SDK 自动重连；终态错误可在设置页查看并手动重新连接。
- [ ] 一个会话投递失败不妨碍另一个会话，恢复后下一条消息可再次送达。
- [ ] 断开后飞书消息不再进入 Session，重新连接后恢复。
- [ ] **入站图片**：A 发一张 PNG/JPEG 图片，A 的原消息出现 `OK` 表情；Session 中助手能描述图片内容（所选模型需支持视觉）；B 收到同一张图片消息，A 自己不再收到图片回显。
- [ ] **入站文件**：A 发一个 PDF，Session 中助手能读到文件内容（FileBlock 只读路径）；B 收到该文件消息。音频/视频按文件处理。
- [ ] **入站降级**：A 发 HEIC/BMP/TIFF 图片或 >20 MB 图片，A 收到明确的文本提示且没有 `OK` 表情，Session 中不出现该消息，B 也收不到；发 >100 MB 文件同理。
- [ ] **出站交付物**：让助手用 `present` 发布一个文件和一个图片，turn 完成后 A、B 都先收到助手卡片、再收到文件/图片消息（图片显示为图片而不是文件）。
- [ ] **卡片内联图片**：让助手在最终回复里用 `![说明](<本地路径>)` 引用一张图片，卡片中直接显示图片而不是本机路径；`present` 已声明过的同一图片不重复显示。
- [ ] **出站降级**：present >30 MB 文件时各绑定收到文本降级（文件名+大小+原因，不含本机路径）；present >10 MB 图片时经 DSH 规范化后仍能作为图片显示。
- [ ] **出站路径收敛（安全）**：让助手 `present` 一个工作区外的文件（例如 `/etc/hosts`），各绑定只收到「文件不在会话工作区或 DSH 附件目录内」文本降级，不含绝对路径、没有文件消息；在助手回复里写 `![x](/etc/hosts)`，卡片保留原 Markdown 文本、不上传图片；再把同一文件复制进 Session 工作区后 `present`/引用，应正常发送。
- [ ] **附件权限**：未添加/未发布 `im:message:readonly` 时发图片，发送者收到降级提示、文本链路正常、日志有可辨识权限警告；未添加/未发布 `im:resource:upload` 时，其他绑定镜像与出站交付物降级为占位/文本，助手卡片与文本消息正常。
- [ ] **双用户可见性**：A 发的图片/文件 B 能看到、A 不回显；助手回复/交付物里的图片与文件 A、B 都能看到。

首次本地目录安装可能通过插件 HMR 生效。**替换已安装包需要重启 DSH**；本仓库的自动验证不会替你重启桌面应用。助手卡片改动同样需要 `pnpm build` 后重启 DSH 才能在运行中的 Host 进程里生效。

## 设计、限制与调查依据

见 [`docs/DESIGN.md`](docs/DESIGN.md)，包括 DSH `0.2.2-rc.5` 的实际 API、消息流、回显抑制与表情回执、去重/防环、DevLead 取舍、崩溃边界及未验证项。

## License

MIT，见 [`LICENSE`](LICENSE)。
