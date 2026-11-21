# 设计与调查记录

## 1. 调查基线

- 运行中的桌面安装版由 `$DSH_INSTALL_DIR/package.json` 确认为 **DSH `0.2.2-rc.5`**。
- 插件签名与事件行为以该安装版 ASAR 内的实际源码为准；开发源码克隆只辅助定位，不作为发布版接口依据。
- 参考实现为 `@xmanrui/dsh-im@5.10.0`。只借鉴接入层，不沿用它的“每个 IM 会话一个 DSH Session”策略。
- 飞书 SDK 固定 `@larksuiteoapi/node-sdk@1.76.0`。官方当前长连接支持企业自建应用，桌面机只需出站公网，不需要公网回调。
- 助手 Markdown 卡片的平台事实（2026-11-21 核对，均来自 `open.feishu.cn` 官方文档）：
  - 卡片 JSON 2.0 必须显式声明 `"schema":"2.0"`，富文本组件为 `{"tag":"markdown","content":"..."}`，支持标题、强调、列表、引用、代码块、链接和表格；表格语法仅 2.0 支持。来源：[卡片 JSON 2.0 结构](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure)、[富文本（Markdown）组件](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text)。
  - 发送仍走 `POST /open-apis/im/v1/messages`：`msg_type=interactive`，`content` 为卡片 JSON 字符串。来源：[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)。
  - `uuid` 是请求级幂等键：相同 uuid 在 **1 小时**内至多成功发送一条消息，最大长度 50 字符；官方未按 `msg_type` 区分。因此 text 回退复用同一 uuid 不会与已落地的卡片重复。
  - 卡片/富文本消息**请求体上限 30 KB**（文本消息 150 KB），超限业务码 `230025`；`230099` 是“创建卡片内容失败”的父码，官方 230099 子错误码表给出：`11310`（模板对应用不可见 / JSON 2.0 元素或组件超过 200 上限 / card action lock）、`200621`（卡片 JSON 解析失败）、`200861`（schema 2.0 使用了 1.0 支持而 2.0 不再支持的组件 tag）；**单 markdown 组件最多 4 个表格**来自[富文本（Markdown）组件](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text)文档，官方子错误码表未给“表格数量超限”的明确子码。注意“请求体”是 HTTP body：卡片 JSON 本身还要作为 `content` 字段再转义一层，所以不能只按卡片 JSON 大小估算。来源：[发送消息错误码](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[通用错误码](https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code)。
  - 卡片 JSON 2.0 需要飞书客户端 **7.20+**；更低版本标题正常、正文显示官方升级提示文案（不会降级成纯文本 Markdown）。来源：[卡片 JSON 2.0 版本更新说明](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-breaking-changes-release-notes)。
  - 限频：发送消息接口文档写“向同一用户 5 QPS、向同一群组为群内机器人共享 5 QPS”，接口频率限制 1000 次/分与 50 次/秒。触发限流的响应随接口而异：本接口（`im/v1/messages`）错误码表是 **HTTP 400 + `230020`**；通用[频控策略](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)文档描述的是 **HTTP 429 + `99991400`**，并注明“部分旧版 OpenAPI 的 HTTP 状态码为 400”。另有消息域限流码 `11232`（创建消息触发系统超限）/`11233`（会话维度限流）/`11247`（请求触发频控），[服务端通用错误码](https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code)的排查建议均指向频控策略。插件对 `230020`/`11232`/`11233`/`11247`/`99991400` 都按“先识别限频业务码、再判 HTTP 4xx”的顺序处理为可重试。来源：[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[频控策略](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)、[服务端通用错误码](https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code)。
  - 参考部署 `dsh-im` 的生产常量也印证了保守预算：卡片 JSON ≤ 24 KB、其自身实测单卡表格 ≤ 5 个（官方富文本组件文档对单 markdown 组件的上限是 4 个表格，本插件以官方 4 个为准）。本插件按**请求体**估算 24 KB，并让小于预算的表格整块保留。
- 回显抑制与表情 ack 的平台事实（2026-11-21 核对，均来自 `open.feishu.cn` 官方文档）：
  - 添加消息表情回复：`POST /open-apis/im/v1/messages/:message_id/reactions`，请求体 `reaction_type.emoji_type` 指定表情类型，响应返回 `data.reaction_id`；权限要求为“开启任一权限即可”：`im:message`（获取与发送单聊、群组消息）或 `im:message.reactions:write_only`（发送、删除消息表情回复）。来源：[添加消息表情回复](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)。
  - 使用限制：已被撤回的消息无法添加表情回复；[系统消息（system）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json#e159cb73)无法添加表情回复；接口频率限制 **1000 次/分钟、50 次/秒**。来源同上。
  - 官方错误码示例：`231001` 表情类型不合法、`231002` 操作人无权对目标消息加表情、`231003` 消息不存在或已被撤回、`231017` 该消息类型不支持本操作、`231022` 用户不在应用机器人的可用范围；权限类错误 `99991672` 表示应用缺少接口所需 scope（响应带 `error.permission_violations`），见[如何为应用申请所需权限](https://open.feishu.cn/document/faq/trouble-shooting/how-to-fix-the-99991672-error)；`99991679` 见[如何解决 99991679 错误](https://open.feishu.cn/document/faq/trouble-shooting/how-to-resolve-error-99991679)。
  - `emoji_type` 合法值列表见[表情文案说明](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce)，`OK` 在列表中，本插件固定用它做回执。
  - 应用权限范围变更需要创建版本、发布并经企业管理员审核后才生效。来源：[如何为应用申请所需权限](https://open.feishu.cn/document/faq/trouble-shooting/how-to-fix-the-99991672-error)（步骤四）、[发布与审核自建应用](https://open.feishu.cn/document/best-practices/intro-to-custom-app-review)。
  - SDK `1.76.0` 的调用形状为 `client.im.v1.messageReaction.create({ path: { message_id }, data: { reaction_type: { emoji_type } } })`，返回 `{ code, msg, data }`，成功判据 `code === 0`。`node_modules/@larksuiteoapi/node-sdk/types/index.d.ts` 的 `messageReaction.create` 与 `node_modules/@larksuiteoapi/node-sdk/lib/index.js` 中 `/open-apis/im/v1/messages/:message_id/reactions` 的实际请求路径一致。

- 图片/文件附件平台事实（2026-11-21 核对，均来自 `open.feishu.cn` 官方文档与固定版本 SDK/DSH 源码）：
  - **下载**：`GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image|file`，`type` 是**必填 query 参数**（文档只定义 `image`/`file` 两种，音频/视频用 `file`）；`type=image` 不支持 Range，`type=file` 支持 Range（分片 ≤32 MB），两者都是“<100 MB”；下载所需 scope 任一：`im:message` / `im:message:readonly` / `im:message.history:readonly`。`im.v1.image.get`/`file.get` 只能下载**机器人自己上传**的资源，不能用于入站，必须用 `messageResource.get`。来源：[获取消息中的资源文件](https://open.feishu.cn/document/server-docs/im-v1/message-resource/get)。
  - **上传图片**：`POST /open-apis/im/v1/images`，`{image_type:'message', image: Buffer}`，≤10 MB，GIF ≤2000×2000、其他 ≤12000×12000；scope 任一：`im:resource` / `im:resource:upload`；**SDK 返回的是解包后的 `{image_key}` 或 `null`，不是 `{code,msg,data}`**。来源：[上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)。
  - **上传文件**：`POST /open-apis/im/v1/files`，`{file_type, file_name, file: Buffer}`，≤30 MB、空文件报 `234010`；`file_type` 枚举 `opus/mp4/pdf/doc/xls/ppt/stream`，`file_name` 需带扩展名；scope 同上；SDK 同样返回解包后的 `{file_key}`/`null`。来源：[上传文件](https://open.feishu.cn/document/server-docs/im-v1/file/create)。
  - **发送**：`msg_type=image` 的 content 为 `{"image_key":"…"}`，`msg_type=file` 为 `{"file_key":"…"}`；仍走 `POST /open-apis/im/v1/messages`（`receive_id_type=chat_id`），`uuid` 是 body 字段、≤50 字符，相同 uuid 1 小时内至多一条成功消息，与 `msg_type` 无关。**上传的 `file_type` 与发送的 `msg_type` 必须匹配**：`opus→audio`、`mp4→media`、`pdf/doc/xls/ppt/stream→file`，否则 `230055`。来源：[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)。
  - **入站事件 content**：`image`=`{image_key}`；`file`=`{file_key,file_name}`；`audio`=`{file_key,duration}`；`media`=`{file_key,image_key,file_name,duration}`（音频/视频资源都用 `type=file` 下载）；`post` 富文本的 `img` 节点=`{tag:'img',image_key}`。来源：[接收消息内容结构](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content)。
  - 相关错误码：`234006` 文件/图片超大小限制、`234010` 空文件、`234011` 无法识别图片格式、`234037` 下载超 100 MB、`230055` file_type 与 msg_type 不匹配、`230017` 非同 app 上传的资源、`230002` 机器人不在会话。
  - **DSH 0.2.2-rc.5 附件事实**（安装版 ASAR 与 `/tmp/dsh-rc5` 源码一致）：`SessionPromptRequest.content` 支持 `{type:'text'}`、`{type:'image',mediaType,data}`、`{type:'file',receiptId}`；`{type:'file',receiptId}` 经 `fileUploads.resolve` 解析，图片 receipt → ImageBlock、文件 receipt → FileBlock；`ctx.fileUploads.uploadImageStream/uploadStream` 返回 staged receipt；`ctx.attachments` 的 `imageLimits` 默认 50 MiB/图、20 图/消息、200 MiB/消息、媒体类型仅 PNG/JPEG/WEBP/GIF；附件存于 `~/.dsh/attachments/v1`，内容寻址、**永不自动清理**；FileBlock 在请求装配时被投影成含只读绝对路径的文本句柄。`ctx.attachments` 抛出的 `AttachmentError`（`name='AttachmentError'` + 稳定 `code`；rc.5 代码表含 `IMAGE_TOO_LARGE`/`IMAGES_TOO_LARGE`/`IMAGE_TOO_MANY_PIXELS`/`IMAGE_DIMENSION_TOO_LARGE`/`UNSUPPORTED_IMAGE_TYPE`/`INVALID_IMAGE*`/`TOO_MANY_IMAGES` 等）会在 `ctx.fileUploads` 的 `store()` 里被包装成 `RemoteError('session/attachment-invalid', { reason: code })` 再抛出；`IMAGE_TOO_LARGE`/`UNSUPPORTED_IMAGE_TYPE` 在 `uploadImageStream` 内直接以同一 RemoteError 形式抛出。插件主路径按 RemoteError 的 `details.reason` 分类，同时保留按 code 结构识别裸 `AttachmentError` 的兜底（跨重复安装副本时 DSH 自身用 `isAttachmentError` 按 code 识别，不使用 `instanceof`）。本地附件后端在实例上暴露 `root`（`$DSH_HOME/attachments/v1`），插件优先用它作为出站路径白名单根（rc.5 desktop 组合已核对可用）；只有在非标准/fixture composition 未暴露 `root` 时才退回 `$DSH_HOME/attachments/v1` 约定兜底，该兜底未完整复刻 `resolveDshHome` 语义（不展开 `~`、把空白 `DSH_HOME` 当字面值、忽略显式 `dshHome` 配置）。
  - **DSH `ctx.get` 语义**（cordis 4.1.0 运行时验证）：`ctx.get('fileUploads')`/`ctx.get('attachments')` 不需要 `inject`，返回服务或 `undefined`，不会抛错；未 `inject` 的 `ctx.attachments` 裸属性访问会抛 `cannot get property without inject`。因此插件保持 `inject` 不变、用 `ctx.get` 可选适配，缺失时降级。
  - **DSH `deliverables/presented`**：`present` 工具在 `tools/result` 成功后 append 该**只读事件**（`{turn, callId, files:[{path, description?}]}`），它不是 surface 事件（无 `surfaceOp`），但 `{global:true}` 的 `session/event` 观察者能收到；`present` 已把路径解析为绝对路径。
  - **DSH Session 工作目录**：`session/event` 监听器第一个参数是 Session 对象，`session.header.cwd` 是创建目录；`working-directory/change` 事件携带 `cd` 后的 effective cwd；据此解析相对 Markdown 图片路径与相对 present 路径。
  - **卡片内联图片语法**：卡片 JSON 2.0 富文本组件的图片语法为 `![hover_text](image_key)`，`image_key` 由**上传图片**接口返回；同一组件还支持 `<audio file_key=…>` 等内嵌语法。来源：[富文本（Markdown）组件](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text)（2026-11-21 抓取 `.md` 版核对）。本插件用该语法实现助手回复的本地图片内联，但不使用 `<audio>` 内嵌（音频/视频仍按文件消息发送）。
  - **助手消息内容**：真实会话日志与 rc.5 实现均表明助手 `message.content` 只有 text/reasoning/tool-call，没有 image/file block；出站图片只能来自助手 Markdown 引用或 `present` 事件。

## 2. 已核实的 DSH 扩展点

### Host 与 Session

安装版提供：

- `sessionController.list({}, signal)`：列出 attached 和 persisted Session；`ctx.sessions.list()` 仅列 live，所以不采用后者做设置列表。
- `sessionController.prompt({ requestId, sessionId, mode: 'queue', content }, signal)`：向任意普通既有 Session 投递。冷 Session 会 resume，可能返回 writer-held、migration-required 等错误；`accepted` 只表示 inbox admission，不表示模型执行完成。同一 `requestId` 重试会去重。DSH 把提交的 `requestId` 原样记入持久事件 `user/message.data.source.rpcId`，这是插件出站侧解码飞书发送方的唯一依据（见第 10 节）。
- `origin: 'subagent'` 需要另一套 `subagents.prompt` 路由，MVP 明确排除，避免把不可续聊子会话误当普通 Session。
- `ctx.on('session/event', …, { global: true })`：显式订阅全局、提交后的持久事件流。只读取已有 `user/message`、`assistant/message`、`turn/end`，不发明插件 Session event type。
- `assistant/message` 是 step 级，不是必然的 turn 最终答复。本实现按 `data.turn` 保存最后一条非空且 `data.interrupted !== true` 的消息，只在对应 `turn/end.reason` 为 `completed` 时广播。对象与字符串两种 reason 形式都支持；`aborted`、`blocked`、`error`、`max-tokens` 等其它结束原因一律不广播，避免把半截文本当成最终回复。
- `user/message.data.source.kind === 'user'` 才是直接人类输入；relay、goal、team 和 DevLead 内部消息使用其它 source kind，不混入共享频道。
- `ctx.fileUploads`（`@deepseek-ai/dsh-file-upload`）提供 `uploadImageStream({sessionId,data,mediaType,signal,name})` 与 `uploadStream({sessionId,data,signal,name})`，返回 staged receipt；`sessionController.prompt` 的 `{type:'file',receiptId}` 被解析成 ImageBlock/FileBlock。插件只调用这两个方法，不注册 resolver（Session Controller 已注册单槽 resolver，冷 Session 会被自动 resume）。
- `ctx.attachments`（`@deepseek-ai/dsh-attachment`）提供 `saveImage`/`readImage`/`imageLimits`，用于出站超限图片规范化；插件不引入 sharp 或任何新图片依赖。
- 两个服务都通过 `ctx.get` 可选获取：安装版 composition 一定挂载它们，但缺失时插件加载不失败、附件路径降级为文本提示。`ctx.get` 不需要 `inject`（cordis 4.1.0 已验证）。
- `deliverables/presented` 是持久、只读、无 surfaceOp 的事件，`ctx.on('session/event', …, {global:true})` 能收到；插件以它为出站文件/图片交付物的唯一信号，不监听 tool/call/tool/result。
- `session/event` 监听器第一个参数是 Session 对象：`session.header.cwd` 提供创建目录，`working-directory/change` 事件提供 `cd` 后的 effective cwd，二者共同用于解析相对路径。

主要安装版证据：`dsh-api-session-controller/src/index.ts`、`src/types.ts`、`dsh-session/src/index.ts`、`src/types.ts`（位于安装包 ASAR 内，只读访问）。

### 设置 UI 与管理通道

- Client 用 `window.__ModuleLoader__.load()` 注册，React 来自页面模块表。
- 独立设置导航使用 `settings.section`。
- 安装版 Plugin Manager 使用 keyed `plugins.bundle.config`，key 必须等于包名；只注册 `settings.section` 不会自动生成插件 Configure 入口，所以两个 slot 都注册。
- Host 管理端点通过 `ctx.connection.fetch.register` 挂到 `/api/dsh-feishu-omni`，Client 通过 `connection.rpc.call('/api', …)` 调用。DSH 外层负责浏览器认证、Host/Origin trust 和相关清理，本插件不新增监听端口。
- Secret 通过 `ctx.credentials.set/resolve/describe` 存取。状态只返回 `configured` 布尔值。
- 非秘密状态使用独立 JSON，而不是运行时重写用户 profile 的 `cordis.patch.yml`。

## 3. 消息流

### 入站

```text
飞书 im.message.receive_v1
  → 校验 user + p2p + 支持的消息类型(含 image/file/audio/media/post-img/media-node)
      + event_id/message_id/chat_id/open_id
  → 立即 ACK，实际工作进入单一 FIFO
  → message_id / event_id 任一已处理则忽略
  → 保存或刷新 open_id → chat_id 绑定
  → 无附件：sessionController.prompt(mode: queue,
       requestId: "feishu-omni:" + message_id + ":" + chat_id,
       text: "[飞书 · label]\n" + text)
    有附件：
      图片  → 下载(type=image, ≤20MB) → 魔数嗅探 PNG/JPEG/WEBP/GIF
              → ctx.fileUploads.uploadImageStream → receipt
      文件  → 下载(type=file, ≤100MB) → ctx.fileUploads.uploadStream → receipt
              （流式，边写 DSH 附件服务边保留 ≤30MB 镜像副本）
      → prompt(text + 占位, content=[text, {type:'file',receiptId}…])
      失败 → 向发送者发明确文本降级、不 prompt、不加 OK、落去重键
  → 接受后才持久化两个去重键
  → 去重键持久化后，best effort 给原始 message_id 加固定 OK 表情
       （一次尝试、不重试，见第 10 节）
  → 对应 user/message 被 Session 正式接纳后，镜像广播给除发送方 chat 外的
     全部绑定用户（解析不出发送方时退回全量广播，见第 10 节）
  → 已下载附件对除发送者外的绑定 chat 重发 image/file 消息
      （每 chat 独立确定性 uuid；二次上传失败降级为占位文本，仅日志）
```

事件 handler 不等待 prompt、模型或 Open API，满足飞书 **3 秒 ACK** 限制。处理前不永久标记 seen，避免参考实现中“标记后执行失败，重投被吞”的问题。接受与写去重键之间若进程崩溃，重投使用同一 DSH `requestId`，由 Session Controller 再挡一次重复输入。

`requestId` 的第三段 `chat_id` 是出站排除发送方的唯一依据：DSH 把它原样写入持久 `user/message.source.rpcId`，所以插件重启、排队消息延迟接纳后仍能解码，不需要内存映射表。prompt 最终失败时只回既有「消息暂时无法投递」提示，**不尝试**加表情；重复投递在写去重键之前就被忽略，因此也不会重复加表情。

### 出站

```text
绑定 Session 的 session/event
  → user/message(source.kind=user)
       解析 source.rpcId：
         - "feishu-omni:<message_id>:<chat_id>"：原文广播，
           排除 chat_id 对应的发送方绑定
         - "feishu-omni:" 开头但解析不出 chat_id（旧格式）：原文全量广播
         - 其它（含 [DSH]）：加 [DSH] 前缀，全量广播
  → assistant/message：按 turn 暂存最后一条非空、未 interrupted 文本
  → deliverables/presented（无 surfaceOp）：按 turn 缓冲 files[path]
  → turn/end：仅 reason=completed 时广播一次；
     aborted/blocked/error/max-tokens 等丢弃暂存文本并清空该 turn 的 present 缓冲
  → 助手回复：先做本地图片内联改写（见第 11 节）
       → 按卡片 JSON 预算分片 → 每收件人依次发送
       im/v1/messages(msg_type=interactive，卡片 JSON 2.0 + markdown 元素)
       卡片失败：同 uuid 回退 / 纯文本回退（见第 9 节）
  → 交付物：每个文件准备/上传一次 → 每绑定 chat 发送
       image: msg_type=image，file: msg_type=file（file_type 按扩展名映射）
       失败：该 chat 文本降级，不阻塞其他 chat/文件
  → 其它消息：每收件人依次发送 im/v1/messages(msg_type=text)
```

飞书事件只接受 `sender_type === 'user'`，因此机器人自己的广播不会再次注入。出站路径只发送，不调用 prompt，不存在“助手回复再次变用户输入”的回路。飞书来源用户消息经 Session 广播是**有意的共享镜像**，不是回环；镜像时排除发送方本人这一收件人（见第 10 节），这是可见性优化，不是把共享频道改成私聊——其他绑定用户仍收到该消息，`[DSH]` 输入与助手最终回复仍全量广播。

助手回复与其它镜像消息分流：只有 `turn/end` 之后的最终助手回复使用 `interactive` 卡片渲染 Markdown；飞书用户消息、`[DSH]` 输入和测试消息继续用 `text`。这样用户随手输入的文本不会被飞书当作 Markdown 解释（例如一个 `#` 或 `*` 开头的句子），同时助手回复获得原生渲染。卡片标题保留 `[助手]`，单条回复不分片时正文即原始 Markdown；多于一条时标题为 `[助手] (i/n)`。

## 4. DevLead 与“同步消息”的边界

MVP 镜像：所有直接人类输入（飞书与 DSH Web）和 lead 的最终助手回复。飞书输入仍进入共享镜像，只是发送方本人不回显（见第 10 节）；这不是把共享频道私聊化。

不镜像：`agent/assistant-stream`、`assistant/attempt`、工具调用/结果、队列内部记录、goal/team/relay 输入、DevLead 子 Session 的独立事件和中途报告。DevLead 的通知/汇报最终会经 lead 自己的助手正式回复呈现，因此团队仍能看到 lead 向人类提交的总结，但不会收到内部调度噪声。

没有虚构 `devlead/*` 事件 API；分类只依赖实际 `user/message.source`。群聊 @机器人、审批/提问控制和子 Session 注入留待后续单独定义所有权。

## 5. 去重、顺序与发送恢复

- 飞书专属接收文档要求用 `message_id`，通用文档使用 `event_id`；两者都保存，任一重复即忽略。最近 2000 个键持久化，超限 FIFO 淘汰。
- DSH 出站以 `sessionId + seq + type` 做进程内去重。`session/event` 不重放历史，重启后不主动回放旧消息。
- 入站和出站共享一个 FIFO，单个收件人也依次写入；多用户同时发言不会绕过这个队列。
- 非助手消息（用户镜像、`[DSH]`、测试消息）的 UUID 为 `dshfo_ + sha256(event key + chat_id)` 的前 40 个十六进制字符，总长度小于飞书 50 字符限制。重试复用 UUID，不同消息/收件人使用不同 UUID。
- 助手卡片按分片派生 UUID：`event key + chat_id + part:<i>` 哈希后仍为 46 字符；同一分片的卡片重试与纯文本回退**共用同一个 UUID**，利用飞书“相同 UUID 1 小时内至多一条成功消息”的幂等语义防止重复。
- 入站附件镜像的 UUID 为 `sha256("attach:" + message_id + ":" + chat_id + ":" + 附件序号)` 派生，同一消息重投或多 chat 均稳定；占位文本复用同一 UUID。
- `present` 交付物 UUID 为 `sha256(turn 事件键 + ":" + chat_id + ":deliverable:" + 文件序号)` 派生；图片/文件 key 在同一 turn 内只上传一次、跨 chat 复用。附件发送失败后的文本降级**复用同一个 UUID**，避免“已落地但响应丢失”时重复。
- 附件相关的下载+暂存链路有 **120 秒**有界等待（`attachmentTimeoutMs`，可注入测试值），镜像/交付物上传与发送各自另有 120 秒等待，全部随 bridge 生命周期取消；因为入站/出站在同一个 FIFO 中，一个大附件的最坏处理时间会推迟后续消息（见第 7 节已知限制）。
- 附件上传/发送失败**不触发 `onError`/Settings 的“最近错误”**（只记日志并按重试阶梯/文本降级处理），避免把临时的附件失败写成连接故障；入站整体降级提示与助手卡片仍沿用原有错误上报策略（重试、回退与 onError）。
- Session prompt admission 与飞书发送默认都最多 3 次尝试，退避 500ms、1s（上限 5s）；prompt 重试复用 DSH `requestId`。最终 admission 失败会向原发送者回一条错误提示。
- 表情回执与去重：ack 只在 prompt admission 成功且两个去重键持久化之后尝试一次；重复投递先命中 `message_id`/`event_id` 去重被忽略，因此不会重复加表情。ack 不写入 `state.json`、不重试、不影响既有 UUID 与 FIFO 顺序，也不改变发送失败的重试分类。
- 429、408、425、5xx 和网络错误可重试；限频业务码 `230020`（本接口文档为 HTTP 400）、`11232`/`11233`/`11247`（消息域限流）与通用频控 `99991400`（HTTP 429，旧版接口 400）优先判为可重试；普通 4xx、认证终态和飞书业务码 `230002`（机器人不在目标会话）不重试。SDK 的非零响应会把业务 `code` 挂到 Error 上，供统一分类；其它未知业务码暂按可重试处理。
- 发送失败保留绑定，继续下一个收件人；后续消息会再次尝试，所以重新把机器人加入会话后可恢复。状态显示最近脱敏错误。
- 每次发送的 SDK `Client` 使用带 15 秒 timeout 和取消 signal 的独立 Axios 实例，所有 Client 共享一个 SDK token cache，按 appId 复用并提前刷新 tenant token；`WSClient` 负责自动重连和终态 `onError`。桥接另设 30 秒有界等待，停止时 AbortController 会取消 prompt、发送与退避，关闭操作同步阻止任何排队连接重新启动。
- App ID 在保存时按 SDK 1.76.0 的实际规则校验：`cli_` 加 16 位十六进制字符，避免 SDK 只记录日志而 UI 永久停留在 connecting。插件显示 phase，终态可手动重新连接。

## 6. 持久化与 Secret

`state.json` 只包含版本、App ID、Session ID、autoConnect、绑定和去重键。写入流程为：读取并校验 → 串行更新 → 同目录临时文件（0600）→ fsync → rename。

点击“连接”时先持久化 `autoConnect=true`，而不是等待异步 WebSocket `onReady`：即使本次连接失败，下次启动也会重试；“断开”才清除该标记。

读取失败按原因分流，只有真正的**内容损坏**才会旁置：

- 文件不存在（ENOENT）：按首次运行处理，空状态就绪，不创建文件。
- JSON 解析失败，或 `normalizeState` 校验失败（schema、version、binding 等）：原文件改名为同目录的 `state.json.corrupt-*`，Store 以空状态就绪，控制器继续初始化并把 `StateRecoveryError` 脱敏呈现在 `lastError`，原文件不会删除。旁置本身的 `rename` 失败时抛 `StateFileError`，原文件保持原位、Store 不就绪，不会以空状态继续。
- `stat`/`readFile` 的 EACCES、EMFILE、EIO 等 I/O 错误：原样向上抛出，不改名、不吞掉、不以空状态继续；Host 初始化失败，原文件保持原样，修复权限/资源后可重试。
- 路径存在但不是普通文件，或文件超过 1 MiB 上限：抛 `StateFileError`，不旁置、不覆盖，Host 初始化失败。非普通文件消息含路径；超限消息含路径、实际大小与上限，并在 `stat` 与 `readFile` 之间文件变大时按实际读到的字节数复检。目录等非普通文件没有可靠且有意义的大小，因此不报大小。超大文件可能是旧版本或用户手写的合法配置，因此不做自动处置，需人工检查后修复或删除。

只有完成旁置的 `StateRecoveryError` 会被吞掉：控制器初始化把它脱敏后继续，`FileStateStore.update()` 在初始化前遇到它也按“已旁置、空状态就绪”继续，但只在 Store 确实已就绪时才继续（否则原样抛出）；其它错误一律向上抛出。

App Secret 仅存在于单次浏览器请求、Host 内存与 DSH credentials。控制器额外用当前 Secret 替换第三方错误消息中的出现次数；Client 保存成功立即清空输入，状态解析器没有 Secret 字段。测试包含 Secret 不出现在状态、RPC 和日志的负向用例。

## 7. 已知限制

1. **不是持久 outbox，不保证崩溃后的 exactly-once。** DSH 已提交但尚未完成飞书发送时若进程崩溃，不会自动补发；飞书至少一次重推与发送 UUID 只覆盖各自的重试窗口。
2. 去重键有容量上限，极旧事件重投可能再次执行。多实例部署需要共享幂等存储和队列，本 MVP 只支持一个 Host 进程。
3. 飞书输入在 DSH queue 中等待时，要等它成为正式 `user/message` 才镜像；这是刻意以 Session 持久事实为准，而不是先显示一个可能投递失败的回声。
4. 长连接保存、权限发布、真实用户姓名、真实重连和机器人被移出会话的提供商错误码只能人工验收；自动测试使用 fake，不声称覆盖真实平台。
5. SDK 的 HTTP 代理、企业网络证书和可用范围策略由部署环境负责。插件不启动第二个 DSH、不修改模型/preset、不打开新端口。
6. `state.json` 是普通本机配置，不是加密数据库；Open ID、chat_id 和 Session ID 会明文保存。Secret 不在其中。
7. 插件替换安装后的 Host JS 需要重启 DSH 才能加载新模块；人工验收由用户执行。
8. 助手卡片依赖飞书客户端 **7.20+** 才能渲染 JSON 2.0 内容；按官方版本说明，旧客户端只显示标题和升级提示（真实旧客户端样式待人工验收）。这是换取列表/代码块/表格原生渲染的代价，插件不做版本探测，也不降级成纯文本 Markdown（那会回到本功能要修复的问题）。
9. 官方富文本组件文档明确单 markdown 组件最多 4 个表格，但未给出“表格数量超限”的专属子码；24 KB 请求体预算是按官方 30 KB 上限与参考实现推算的保守值。超出预算的长回复已分片，但单条分片内仍可能因 >4 个表格被飞书拒绝（可能以 `230099` 呈现，自动测试不覆盖真实平台），届时按载荷拒绝路径同 UUID 回退纯文本。真实租户的大表格回复需要人工验证。
10. 纯文本回退复用同一 UUID 依赖飞书“至少一次/至多一条”的幂等承诺；真实平台在“卡片已落地但响应丢失”场景下重发同 UUID 文本的具体响应（成功或去重错误）未在自动测试中验证，只保证不会出现两条消息的最佳努力。
11. 回显抑制依赖持久 `requestId` 编码：升级后首次重放或延迟接纳旧格式（`feishu-omni:<message_id>`）的历史消息时可能偶发一次回显；发送者绑定在 prompt 与事件之间被刷新（`chat_id` 变化）时同样退回全量广播。正常新消息不回显，其他用户的可见性始终优先。
12. 表情 ack 是 best effort：一次尝试、不重试、5 秒有界超时；缺权限、限频、消息撤回/系统消息、网络失败都只记日志、不补发。admission 成功到 reaction 调用之间若进程崩溃或 bridge 停止取消，该消息不会被补加表情（去重键已持久化，重投会被忽略）。
13. 缺少 `im:message.reactions:write_only`（或更宽的 `im:message`，或已添加但未发布新版本）时没有 `OK` 回执，消息投递与广播完全正常，日志出现可辨识权限警告；权限在真实租户中的发布、审核与生效需人工验收。
14. 真实飞书平台的 `OK` 表情渲染、限频（1000 次/分、50 次/秒）、撤回/系统消息限制、可用范围管控与日志节流表现均未在自动测试中覆盖，需要人工验收。
15. **模型视觉能力取决于上游模型**：DSH 在 prompt admission 时按模型的 `inputModalities` 决定是否接受图片；模型不支持视觉时插件收到 `MODEL_DOES_NOT_SUPPORT_IMAGES` 并给发送者文本提示，不重试、不加 `OK`。真实模型对图片内容的“理解质量”不在插件控制范围。
16. **附件永不自动清理**：入站与出站规范化的字节都存入 DSH 附件服务（`~/.dsh/attachments/v1`，内容寻址），DSH 不自动删除；插件也不做清理。长期使用会累积磁盘占用，需要运维自行清理该目录（清理后历史 FileBlock 的只读路径会失效）。
17. **>100 MB 资源不支持**：飞书 `type=file` 下载 ≥100 MB 需要 Range 分片（≤32 MB/片），`type=image` 完全不支持 Range；插件使用一次性流式下载，因此入站文件上限 100 MB、图片上限 20 MB。
18. **群聊仍不支持**：图片/文件只接受 p2p 用户消息；群聊 @机器人、合并转发/卡片消息里的资源（飞书返回 234043）不处理。
19. **出站文件/图片平台限制**：文件 ≤30 MB 且无分片/断点上传；图片 ≤10 MB，GIF ≤2000×2000、其他 ≤12000×12000。超过 10 MB 的图片先用 DSH `attachments.saveImage` 规范化（最长边/像素受限），规范化后仍超限则文本降级；GIF 的尺寸限制 DSH 规范化不保证满足（2048 像素预算高于飞书 GIF 的 2000 限制），超大 GIF 可能只能降级。音频/视频统一按 `file_type=stream` 以 `msg_type=file` 发送（飞书要求 file_type 与 msg_type 匹配），不做内联播放。
20. **入站镜像二次上传是 best effort**：其他绑定用户看到的图片/文件依赖同一 app 重新上传；缺 `im:resource:upload`、资源超过 10 MB（图片，且无规范化副本）、文件超过 30 MB 或可重试错误重试耗尽时才发占位文本（可重试码仍先按 11.4 指数退避重试）。
21. **卡片内联图片改写范围有限**：只处理**行内** Markdown 图片语法（`![alt](<path>)` / `![alt](path)`），跳过 fenced code block、4 列缩进的代码块（tab 按 4 列 tab stop 展开；引用块/列表容器内也识别；保守实现：4 列缩进的嵌套列表内容也一并跳过）、行内代码 span（`` `...` ``）与反斜杠转义的 `\![alt](path)`；引用块内的行内图片仍会处理，HTML `<img>`、跨行图片语法、链接引用式图片（`![alt][ref]`）不改写。改写失败（含根外路径、上传失败）保留原 Markdown；present 去重时也保留原文，卡片只显示文本、不含字节，飞书客户端可能显示为破图/路径文本。
22. **相对路径依赖 Session cwd**：使用 `session.header.cwd` 与 `working-directory/change` 的 effective cwd；插件重连后若从未见过该 Session 的事件，会退回 `sessionController.list` 的 cwd（可能滞后于真实 `cd`）。无法解析时保留原 Markdown。
23. **大附件阻塞共享 FIFO**：附件下载/暂存/上传发生在单一 FIFO 内，单个大附件的 120 秒上限会推迟其他用户的消息与助手回复；MVP 接受这一顺序性代价，未做后台附件队列。
24. **`present` 是否可用取决于 Session 的 agent preset**：标准/默认 preset 挂载了 `present`（本插件依赖它产生 `deliverables/presented`）；若绑定 Session 使用未挂载 present 的 minimal preset，出站交付物链路不可用，但助手 Markdown 内联图片仍可用。
25. **未绑定 staged receipt 不会主动释放**：一条多附件消息在暂存到一半失败、或 prompt 被 DSH 拒绝（如模型无视觉）时，已 mint 的 receipt 没有公开释放 API；对应的内容寻址字节会留在 `~/.dsh/attachments/v1` 直到进程/附件服务生命周期结束。次数受消息量约束，且相同内容按 sha256 去重，不会无限膨胀；DSH rc.5 没有提供 receipt 回收接口，插件不绕过这一边界。
26. **cwd 缓存不主动裁剪**：Controller 的 `sessionCwds` 会记录连接期间观察到 cwd 的每个 Session（子 Agent 也在内），只在断开连接时整体清空；长期运行且大量 Session 时是一个很小的内存占用，未做 LRU。
27. **真实平台未验证**：HEIC/BMP/TIFF 拒绝提示、`im:message:readonly`/`im:resource:upload` 的发布生效、>10 MB 图片规范化、present 交付物在真实客户端的显示、GIF 尺寸边界、附件消息的 uuid 幂等行为均需真机人工验收（自动测试使用 fake 网关与本地 SDK adapter）。
28. **出站只桥接允许根内的文件**：`present` 交付物与卡片内联图片只读取 Session cwd 或 DSH 附件目录内的普通非空文件；其它位置需要 agent 先复制进 Session 工作区。收敛器先 `realpath` 再按真实路径读取，没有用 `openat`/`O_NOFOLLOW` 消除校验与读取之间的极小 TOCTOU 窗口——威胁模型是共享 Session 被 prompt 注入，而不是同机并发攻击者。`realpath` 也不识别 hardlink：工作区内一个指向同卷根外文件的 hardlink 仍会通过收敛；制造该 hardlink 需要同卷 `link` 权限，效果等价于文档已允许的「先把文件复制进工作区」，因此不超出既定威胁模型。收敛还要求**至少一个已知允许根**：cwd 与附件根都不可用时，绝对工作区路径同样被拒绝（fail closed），不只是相对路径依赖 cwd。
29. **入站镜像副本共享消息级 60 MB 预算**：多张大图/大文件可能先耗尽预算：文件镜像对其它绑定用户降级为占位文本，图片改用 DSH 规范化副本重传（仍不可用才占位）；DSH 侧 prompt 附件与文本链路不受影响。

## 8. 自动测试覆盖

fake 测试覆盖：text/post 解析、非法事件、双键去重、prompt 失败重试、并发 FIFO、广播、completed turn 聚合、interrupted 片段与非 completed turn 抑制、DSH/DevLead source 过滤、永久飞书业务码与单收件人失败隔离、稳定 UUID 重试、永久 pending 请求取消、关闭时排队连接、状态原子保存/读取、损坏状态旁置、I/O 错误/非普通文件/超限文件不旁置、读取后按实际字节数复检超限（`stat` 与 `readFile` 之间文件增长）、旁置 rename 失败上抛、初始化前 `update()` 遇旁置恢复后以空状态继续、控制器恢复、并发状态更新、配置连接生命周期、Secret 脱敏、管理 envelope 校验、Client 两个设置 slot 与响应校验。助手卡片部分覆盖：卡片 JSON 2.0 结构与 `[助手]` 标题、单卡不拆分时原文逐字节保留、长回复分片数量/顺序/`(i/n)` 标记、分片 UUID 确定性、每片按含二次转义的请求体估算 ≤24 KB（普通文本与引号/反斜杠密集文本）、代码围栏闭合/重开与未闭合围栏补齐、单行硬切、CRLF 归一、自定义预算、小表格整块保留与大表按行切分不丢行、`230099` 拒绝后同 UUID 纯文本回退且不泄漏卡片 JSON、网络不确定结果同 UUID 重试与回退、`230020`/旧接口 400 限频码与 `11232`/`11233`/`11247` 消息限流码（含 HTTP 400 包裹）可重试且回退分类为 `rejected`、`230002` 永久错误不重试不回退、分片中途永久失败后停止该收件人其余分片、卡片路径 stop 取消、非助手消息仍为 `text`。回显抑制与表情 ack 部分覆盖：飞书 `user/message` 镜像按 `rpcId` 排除发送方 `chat_id` 而其他绑定用户仍收到；`[DSH]` 人类输入与助手最终回复仍全量广播；旧格式 `feishu-omni:<message_id>`（无 `chat_id`）与“解析出的 chat 不在当前 bindings”都退回全量广播；admission 成功后对原始 `message_id` 加固定 `OK` 且只尝试一次；admission 最终失败不加表情并保留既有「消息暂时无法投递」提示；`message_id`/`event_id` 去重命中时不加表情；reaction 失败分类（权限码、限频码、HTTP 429、网络错误、撤回类业务码）正确，缺权限时 prompt 与广播不受影响且只记一条 warning，恢复后记一条 info，失败类别变化会重新告警，ack 挂起时有界超时并会取消在途请求、不会阻塞后续入站；bridge 停止会立即取消挂起的 ack；去重键落盘失败时不加表情（锁定“先落盘后 ack”的顺序）；ack 日志摘要从 axios 风格响应中提取 `code=/status=/msg=`，超长/含换行 msg 截断清洗、非字符串 msg 忽略、凭据脱敏且不泄漏请求体/headers/URL。另以真实 SDK `Client` / `WSClient` 加本地 Axios adapter（无网络）验证 tenant token、text 与 interactive 消息发送、`addReaction` 的 SDK 调用形状与 `/reactions` 端点、WebSocket endpoint 和 `$return_headers` 的响应解包。
附件部分覆盖：`image`/`file`/`audio`/`media`/`post-img` 事件解析、缺失资源键忽略、图片魔数嗅探（PNG/JPEG/WEBP/GIF 与 HEIC/BMP/TIFF/SVG 识别）、`file_type` 映射（含音频/视频按 `stream` 以匹配 `msg_type=file`）、入站图片下载 → `uploadImageStream` → prompt receipt 的完整形状、文件流式 `uploadStream`、post 多图、下载/暂存/超限/无附件服务/模型不支持图片的降级（不 prompt、不加 OK、落去重键、提示不含本机路径、文本链路不受影响）、入站镜像到其他绑定（图片/文件、占位降级、单收件人失败隔离、UUID 确定性、无其他绑定时不重复上传）、重复投递不重复下载/暂存/prompt/ack、stop 取消挂起下载、1024 个负向边界（真实 SDK adapter 验证 `/im/v1/images`、`/im/v1/files`、`/messages/:id/resources/:key?type=` 的请求形状与解包返回值）。出站部分覆盖：`deliverables/presented` 按 turn 缓冲、completed 先卡片后附件、非 completed 清空缓冲且不投递、文件/图片分类上传、上传一次跨 chat 复用、每 chat 确定性 UUID、缺失/为空/超 30 MB 文件与超 10 MB 图片（规范化/失败）降级、单收件人发送失败同 UUID 文本降级且不影响其他收件人、相对 present 路径按 cwd 解析、同路径去重、助手 Markdown 本地图片改写（相对/绝对/尖括号、URL/image_key/代码围栏/缺失/非图片跳过、>10 MB 规范化、present 去重、上传失败保留原文、重复引用只上传一次、cwd 未知时保留），以及 Controller 层 `session.header.cwd`/`working-directory/change` 到相对路径解析的端到端接线；unknown cwd（`cwd: null`）与 `sessions.list` cwd 回退各有独立用例；deliverable 的瞬时限频重试、永久失败单次降级、多 present 批次合并、空文件/目录、扩展名保留、超长文件名截断、缓冲区上限告警、四反引号/未闭合围栏边界、行内代码 alt 保真、图片交付物多 chat 只上传一次、多分片卡片先于附件发送均有覆盖。出站路径收敛覆盖：工作区内普通文件、DSH 附件根内文件允许；外部绝对路径、`../` 逃逸、symlink 指向根外拒绝（present 发不含绝对路径的降级文本，inline 保留原 Markdown）；symlink 指向根内允许；workspace 根自身/目录/不存在/空文件分别给出 `not-file`/`missing`/`empty`；`root + sep` 严格前缀边界（`work` 不匹配 `work-escape`）；symlink 作为 Session cwd；4 列缩进（含引用块/列表容器与 tab stop）代码块与转义 `\!` 不改写。另覆盖 DSH `session/attachment-invalid` 的 `reason` 映射（生产形状：上传服务把 `AttachmentError` 包成 RemoteError）与裸 `AttachmentError` code 兜底分类（字节/像素/尺寸/格式/数据无效/数量，聚合字节上限使用「减少图片数量或压缩」提示、cause 包裹、存储类错误仍走通用文案）、admission `RemoteError` 同码映射、引用块/列表容器与 tab stop 下的缩进代码不被改写、偶数反斜杠后的图片仍改写、附件镜像无扩展名/点文件补 `.bin` 且 `file_type` 按最终名重算、attachment root 查询抛错时 fail-closed、workspace 与附件根都未知时的 `no-roots` 提示、turn 结束后迟到的 `deliverables/presented` 被忽略且不投递、已结束 turn 集合按 256 上限淘汰最旧项（最近 turn 仍被记住）。

测试边界：`tests/host-adapters.spec.ts` 的 Cordis `Context` 和 Session Controller 全部是 mock，只验证本插件构造的 list/prompt 调用形状；安装版签名兼容性来自对目标 ASAR 源码的只读核对，不等同于真实 Host 集成测试。SDK 测试也只使用本地 HTTP adapter，不验证飞书实际权限、事件投递或 WebSocket 服务行为。依赖 `chmod` 权限位的用例在 root 与 Windows 上自动跳过，POSIX `0600` mode 断言在 Windows 上不执行（Windows 上 chmod 不阻止读取或改名，`stat` 的 mode 也是合成值）。

不访问真实飞书，不安装到正在运行的 DSH，不读取真实 credentials，不依赖任何测试 Secret。

## 9. 助手 Markdown 卡片（出站渲染）

### 目标与边界

只把**最终助手回复**升级为 Markdown 卡片；其它镜像消息（飞书用户消息、`[DSH]`、测试消息）保持 `text`。原因：

- 用户输入是任意文本，不应该被飞书按 Markdown 解释（以 `#`、`*`、`1.` 开头的普通句子会被渲染成标题、列表）；
- 助手回复通常自身就是 Markdown，且可能长达数千字、包含多个代码块，需要卡片 + 分片。

### 卡片结构

`src/card.ts` 负责构造卡片 JSON，`src/lark.ts` 的 `sendMarkdown` 负责发送：

```json
{
  "schema": "2.0",
  "header": {
    "title": { "tag": "plain_text", "content": "[助手] (1/2)" },
    "template": "blue"
  },
  "body": { "elements": [{ "tag": "markdown", "content": "<原始 markdown 分片>" }] }
}
```

- `header.title` 为 `plain_text`，内容固定以 `[助手]` 开头；多条分片时追加 `(i/n)`。保留标识让用户一眼区分广播来源。
- `header.template: blue` 提供固定的助手色调；`body.elements` 只放一个 `markdown` 元素，避免元素数（单卡 200）与表格数（单 markdown 组件 4 个）上限被轻易触及。
- `msg_type` 固定 `interactive`，`receive_id_type=chat_id` 与 text 路径完全一致。

### 大小预算与分片

- 卡片消息的**请求体**上限按 **24 KB** 估算（飞书上限 30 KB，留 6 KB 余量；参考部署按卡片 JSON 24 KB）。预算必须计入**二次 JSON 转义**：markdown 在卡片 JSON 的 `content` 字符串里转义一次，卡片 JSON 作为消息 `content` 字段又转义一次，引号/反斜杠密集文本最多膨胀到 4 倍。实现用 `JSON.stringify(JSON.stringify(markdown))` 的 UTF-8 字节数计量，并预留 1 KB 给卡片包装、`(i/n)` 标题与 HTTP 信封（`receive_id`/`msg_type`/46 字符 uuid）。确定性随机用例（60 组，提交在 `tests/card.spec.ts`）与本地 fuzz（300 组随机/病态文本）验证：分片后模拟 SDK 请求体最大 23.3 KB，低于 30 KB 上限。
- 分片算法（`splitAssistantMarkdown`）：
  1. 单卡可容纳时**逐字节原样返回**，不改动空白与换行；
  2. 否则按行扫描成单元：段落（空行分隔）与代码围栏块（成对围栏整体保留；未闭合围栏补上闭合标记）；
  3. 单元超预算时按行打包；代码围栏超预算时每片重新写 `opening + content + closing`（保留 info string），未闭合围栏的每一片都补结束围栏；
  4. 单行仍超预算时按 Unicode code point 边界硬切，不会切开代理对；
  5. 单元之间用空行拼接，并逐片校验转义字节数 ≤ 预算；任何异常超限再走硬切兜底，保证不丢内容。
- 分片结果只依赖回复文本和常量，因此同一 turn 的重试、进程重启后的同 key 发送都会得到相同的分片与 UUID；分片条数不写入持久状态。
- 已知取舍：只按段落/围栏切分，不解析列表内部结构，超长宽松列表被拆开时可能变成多个独立列表；小于预算的表格整块保留，超过预算的大表按行切开（第二片起不重复表头，渲染上会变成多个表格片段），若单卡仍出现 >4 个表格，可能被飞书拒绝（官方只规定 4 表格上限，未给明确子码；届时同 UUID 回退文本）。

### 顺序、限频与 UUID

- 每个收件人内部按分片序号串行发送，收件人之间也串行（沿用全局 FIFO），同一回复的分片不会交错。
- 分片 UUID = `uuidFor(event key + chat_id + ':part:' + i)`，46 字符，满足飞书 50 字符上限；卡片重试与文本回退共用同一 UUID。
- 429 / `230020`（本接口 HTTP 400）/ `11232` / `11233` / `11247` / 旧接口 `400+99991400` 属于可重试码（先识别限频业务码，再判断 HTTP 4xx，避免把 400 包装的限频误判成不可重试），沿用指数退避（500ms、1s，上限 5s），没有额外引入分片间固定延迟。
- 某收件人某片最终失败时停止该收件人剩余分片（避免缺片继续发），继续下一个收件人；已发出的分片不回滚。

### 失败分类与回退阶梯

`src/errors.ts` 新增三分类 `deliveryFailureKind`：

| 分类 | 判定 | 处理 |
| --- | --- | --- |
| `permanent` | 飞书业务码 `230002` / `99991661` / `99991663` / `99991664` | 不重试、不回退（换 text 也送不到） |
| `rejected` | 其它飞书业务码（服务端已答复，消息未创建），或 4xx（408/425/429 除外） | `230001`/`230025`/`230099` 等载荷拒绝不重试，直接同 UUID 回退 text；限频类业务码 `230020`/`11232`/`11233`/`11247`/`99991400` 先按 `isRetryable` 指数退避，耗尽后同样同 UUID 回退 text |
| `uncertain` | 无业务码的传输错误、超时、5xx、408/425/429 | 同 UUID 重试；耗尽后仍以同 UUID 回退 text |

回退文本为 `[助手]\n<该片 markdown>`（多片时为 `[助手] (i/n)\n…`），绝不包含卡片 JSON。若回退 text 也失败，沿用原有 `sendWithRetry` 的错误上报与单收件人隔离。

理由：飞书返回业务码说明服务端已处理且没有创建消息，此时回退 text 不可能重复；只有网络超时/5xx 才可能“已落地但客户端不知道”，复用同一 uuid 是官方幂等语义（相同 uuid 1 小时内至多一条成功消息）下唯一不会有重复消息的做法。

### 权限与降级

- 发送接口未变：`im:message.p2p_msg:readonly` 仍用于收消息；`interactive` 仍由 `im:message:send_as_bot`（或更宽的 `im:message`）覆盖，卡片路径没有新增权限。本次发布为表情 ack 新增 `im:message.reactions:write_only`（或复用 `im:message`），与卡片无关，见第 10 节。
- 旧客户端（<7.20）不渲染 JSON 2.0 正文：标题仍在，正文显示官方升级提示文案。插件不自动降级为 text，因为那正是本次要修复的“Markdown 显示为纯文本”问题；是否支持旧客户端应作为显式配置项，而不是默认行为。
- 未验证项：真实租户下卡片首次发送的权限、真实旧客户端的升级提示样式、单卡 >4 个表格被拒绝（官方未给明确子码，可能为 `230099`）后的回退路径——均需人工验收。

## 10. 回显抑制与表情 ack

本次发布的两项体验优化都遵守同一条原则：出站镜像只依赖 Session 的**持久事件**与一次性的 best effort 调用，不引入需要跨重启维护的插件内存状态。回显抑制把发送方编码进 `requestId`；表情 ack 则完全不参与投递链路。

### 10.1 发送者不回显

#### 编码

- 入站 prompt 的 `requestId` 为 `feishu-omni:<message_id>:<chat_id>`；`chat_id` 是该条飞书消息所属单聊的 chat。
- `sessionController.prompt` 把 `requestId` 原样写入 DSH 持久事件 `user/message.data.source.rpcId`（见第 2 节）。
- 出站处理 `user/message` 时只读 `source.rpcId`：有 `feishu-omni:` 前缀，且从右往左最后一个 `:` 之后是非空 `chat_id`，就把它当作发送方 chat。

#### 解码规则

1. 不是字符串或没有 `feishu-omni:` 前缀 → 非飞书来源，按 `[DSH]` 处理，全量广播；
2. 有前缀但解析不出 `chat_id`（旧格式 `feishu-omni:<message_id>`，或尾段为空）→ 视为飞书来源、发送方不可知，全量广播；
3. 解出 `chat_id` 但在当前 bindings 里没有同一 `chatId` 的绑定 → 没有可排除对象，全量广播；
4. 解出的 `chat_id` 命中某个绑定 → 广播时跳过该绑定，其他绑定用户全部收到。

```text
rpcId = "feishu-omni:om_xxx:oc_alice"
                prefix   message_id  chat_id
bindings = [alice(oc_alice), bob(oc_bob)]
→ 广播收件人 = [bob]
```

四种兜底：`rpcId` 不以 `feishu-omni:` 开头 → 仍按 `[DSH]` 全量广播；前缀存在但解不出 `chat_id`（旧格式）→ 全量广播；解出的 chat 不在 bindings → 全量广播；发送者绑定在 prompt 与事件之间刷新 → 旧 chat 不在 bindings，同样全量广播。四种情况都只影响“是否排除发送方”，不改变消息本身与其他用户的可见性。

#### 为什么不用内存映射表

“收到事件时记 `message_id → chat_id`，出站时查表”看似直接，但有三处会丢状态：

- 插件重启后表丢失；重启前已 admission、重启后才成为 `user/message` 的排队消息无法解析；
- DSH 的 prompt admission 成功不等于立刻产生 `user/message`，等待期间崩溃/重连同样丢表；
- Session 事件重放（恢复、测试回放）时表里没有对应项。

chat 编码进 `requestId` 后，`rpcId` 是 Session 事件日志里的持久事实，进程重启、排队延迟接纳和事件重放都能解码，也不需要额外的清理逻辑。代价是 `requestId` 变长；`message_id` 与 `chat_id` 都按不透明字符串处理，插件不对其内部格式做假设。

#### 兜底口径与已知代价

**可见性优先：回显抑制是 best effort，宁可偶发一次回显，绝不丢失其他用户的可见性。** 因此：

- 解析不出发送方时一律全量广播，不猜测、不静默丢弃；
- 解出的 chat 已不在 bindings（绑定刷新/删除）时全量广播，不按 open_id 跨 chat 猜测；
- 发送者绑定在 prompt 与事件之间被刷新（`chat_id` 变化）时，旧 chat 已不在 bindings，同样全量广播。

已知代价：旧版本插件提交的 `feishu-omni:<message_id>` 历史消息在升级后首次重放或延迟接纳时可能偶发一次回显；正常新消息不会。助手最终回复与 `[DSH]` 输入完全不受影响，仍广播给全部绑定用户；单收件人失败隔离、FIFO 顺序与既有 UUID 规则也不变。镜像文本仍保留 `[飞书 · 发送者]` 前缀，只是该前缀不再发给发送者本人。

### 10.2 表情 ack

#### 行为

- **固定表情**：`ACK_EMOJI = 'OK'`（定义在 `src/bridge.ts`），即飞书 `emoji_type=OK`，官方[表情文案说明](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce)列出该合法值；不提供配置项。
- **目标消息**：**用户原始消息**的 `message_id`，不是镜像广播出去的消息，也不是助手回复。
- **时机**：仅在 `sessionController.prompt` admission 成功、且两个去重键（`message_id`、`event_id`）已持久化之后，才调用一次 `POST /open-apis/im/v1/messages/:message_id/reactions`。先持久化去重键再加表情，保证“重投不会重复加表情”，也保证慢/失败的 ack 不会让消息看起来还没处理。
- **不会加表情**：事件被忽略（群聊/机器人/不支持类型/空文本）、`message_id` 或 `event_id` 去重命中（重复投递）、prompt 最终投递失败（此时保留既有「消息暂时无法投递」提示，不额外加表情或错误）。
- **失败语义**：一次尝试、不重试；有界超时 **5 秒**（`DEFAULT_ACK_TIMEOUT_MS`，可通过 `ackTimeoutMs` 注入测试值）。同一个 5 秒上限既由 bridge 的 `bounded` 等待保证，也通过 `AbortSignal.any([lifecycle, AbortSignal.timeout(5s)])` 传给 SDK，因此超时或 bridge 停止都会真正中止在途 HTTP 请求，不会拖到 SDK 自己的 15 秒 HTTP timeout。任何失败只记日志，不影响已完成的 prompt 与广播；不写入 Settings 的连接状态/最近错误，不触发 `onError`。

#### SDK 调用与响应判定

SDK `1.76.0`：

```ts
const response = await client.im.v1.messageReaction.create({
  path: { message_id },
  data: { reaction_type: { emoji_type: 'OK' } },
})
if (response.code !== 0) throw Object.assign(new Error(...), { code: response.code })
```

与官方文档一致：`POST /open-apis/im/v1/messages/:message_id/reactions`，响应含 `data.reaction_id`；插件不保存 `reaction_id`，因为不做删除/统计（能力边界见 README 的“明确不做”）。请求复用按 appId 共享的 tenant token cache 和插件统一的 15 秒 HTTP timeout；ack 外层再套 5 秒有界等待并同时取消请求，因此最坏情况下单条消息的 ack 最多占用 FIFO 5 秒，而不受 SDK 默认重试/长超时影响。

#### 错误分类

`reactionFailureKind(error)` 分三类：

| 分类 | 判定 | 日志 |
| --- | --- | --- |
| `permission` | 业务码 `99991672` / `99991679` | warning 明确提示“在飞书开放平台添加 `im:message.reactions:write_only`（或更宽的 `im:message`）权限并发布新应用版本” |
| `rate-limit` | HTTP 429，或限频业务码 `230020` / `11232` / `11233` / `11247` / `99991400` | warning，提示限频（1000 次/分、50 次/秒），不重试 |
| `other` | 网络/超时、消息已撤回（`231003`）、系统消息、`231001`/`231017`/`231022` 等业务码、未知错误 | warning，附脱敏后的 `code=/status=/msg=` 摘要 |

日志摘要由 `reactionFailureDetail(error)`（`src/errors.ts`）生成，格式为 `code=<飞书业务码> status=<HTTP status> msg=<飞书 msg>`，缺失项省略：业务码复用 `providerCode`（与重试分类同一套取值逻辑，如 `231002`/`231022`/`99991672`），HTTP status 复用 `httpStatusOf`，`msg` 从 `error.response.data.msg`（以及 `error.data.msg`/`error.msg` 等同类形状）取字符串值。`msg` 会先做凭据脱敏（`app_secret`/`appSecret`/`tenant_access_token` 形状）、把换行/制表符等控制字符压成空格并截断到 200 字符；非字符串的 `msg` 直接忽略而不是序列化，因此结构化响应体不会进入日志。helper 只读取错误/响应包络里的标量字段，不读取 axios 的 `config`（请求体、headers、URL 查询参数），也不打印原始 error 对象；纯网络错误没有 response 时降级为 `msg=<脱敏后的 error.message>`。同一摘要只在真正输出 warning 时计算，被节流掉的同类失败不会重复生成。

`99991672` 是官方文档化的“应用缺少接口所需 scope”错误（响应带 `error.permission_violations`，修法是申请权限并创建/发布版本）。`99991679` 的官方 FAQ 描述为调用方未获得所需授权（示例是 user access token 缺少用户授权）；本插件以 `tenant_access_token` 调用，该码同样表示授权/权限不可用、重试无意义，因此与 `99991672` 同归 `permission` 类。真实平台报哪个码取决于租户与权限配置，日志给出的修法相同。

#### 日志节流

bridge 在内存里记录“上一次 reaction 失败类别”（`permission` / `rate-limit` / `other` / `null`）：

- 首次失败或类别变化：记一条 warning；
- 同类失败连续出现：不重复记录，避免每条消息刷屏；
- 之前处于失败态、某次成功后：记一条 info（表情回执已恢复），并重置状态。

计数不落盘，重启后从“无失败状态”重新开始；bridge 停止时被取消的 ack 不记 warning，因为这不是投递或权限问题。

#### 权限与版本发布

- 添加消息表情回复需要 `im:message.reactions:write_only`，或更宽的 `im:message`（官方“开启任一权限即可”）。
- 权限范围变更必须**创建版本并发布**、经企业管理员审核后才生效；未发布前调用返回权限类错误。
- 未添加或未发布时：消息流完全正常（入站、prompt、广播、助手卡片不变），只是没有 `OK` 回执；日志出现上表的 `permission` warning。
- 平台限制（官方文档）：已被撤回的消息无法添加表情回复；系统消息（`system`）无法添加；接口频率限制 1000 次/分钟、50 次/秒。

#### 为什么这样取舍

- **不重试**：ack 是体验增强，不是投递链路的一部分。重试会放大限频、拖慢单一 FIFO，并让缺权限场景刷屏；一次尝试 + 日志节流足够。
- **5 秒有界**：把最坏路径限制在单条消息 5 秒内，而不是让 bridge 被 SDK 默认重试/长超时拖住。
- **不写连接状态**：Settings 的“最近错误”描述连接/凭据可用性；把缺表情权限误报成连接故障会误导用户。
- **固定 `OK`**：不扩大配置面，也避免把用户输入当配置解析；`OK` 是官方合法值，语义就是“收到”。

#### 未验证项

真实租户下的权限发布与生效、`OK` 表情渲染、限频、撤回/系统消息、可用范围管控与日志节流表现均未在自动测试中覆盖（自动测试使用 fake 网关与本地 Axios adapter），需要人工验收。

## 11. 附件：入站与出站

### 11.1 目标、硬约束与能力边界

目标是让飞书用户与共享 Session 之间双向传递图片和文件，同时满足任务的硬约束：**不新增任何 agent tool（不新增 DSH tool / MCP tool），不新增依赖**。因此实现完全复用两侧已有能力：

| 环节 | 复用的能力 |
| --- | --- |
| 入站图片 → Session | DSH `ctx.fileUploads.uploadImageStream` + `sessionController.prompt` 的 `{type:'file',receiptId}` → DSH 原生 ImageBlock |
| 入站文件 → Session | DSH `ctx.fileUploads.uploadStream` → 原生 FileBlock（请求装配时投影为只读绝对路径文本） |
| Session → 出站文件/图片 | agent 已有的 `present` 工具 → `deliverables/presented` 会话事件 |
| Session → 出站内联图片 | 助手 Markdown 里的 `![alt](<path>)` → 飞书 `image_key` 改写 |
| 出站超限图片 | DSH `ctx.attachments.saveImage`/`readImage`（DSH 自带 sharp 规范化） |
| 镜像给其他飞书用户 | 插件把已下载字节重新上传成飞书 image/file 消息 |

明确不做：群聊附件、合并转发/卡片内资源（飞书 234043）、>100 MB Range 下载、附件自动清理、音视频内联播放、出站媒体消息（audio/media 统一按文件发送，不做内联播放）。`post` 的 `img` 与 `media` 节点都按附件处理（`media` 按视频文件）。

### 11.2 入站链路

```text
im.message.receive_v1
  → events.ts：image/file/audio/media/post-img+media-node → InboundMessage.attachments[]
       image  {type:'image', kind:'image', key:image_key}
       file   {type:'file',  kind:'file',  key:file_key, name:file_name}
       audio  {type:'file',  kind:'audio', key:file_key}
       media  {type:'file',  kind:'media', key:file_key, name:file_name}
  → bridge.processInbound
       绑定 open_id → chat_id
       stageInboundAttachments：
         image: messageResource.get(type=image) → 头部嗅探 → 全量 ≤20MB
                → uploadImageStream({sessionId, data, mediaType, name:'image.<ext>'})
         file : messageResource.get(type=file) → collectingStream(≤100MB, 保留 ≤30MB)
                → uploadStream({sessionId, data, name})
       失败：AttachmentFailure → 文本降级 + 落去重键，prompt 不调用、ack 不加
  → prompt(text = "[飞书 · label]\n" + 文本 + 占位,
           content = [text, {type:'file', receiptId}…])
       DSH：image receipt → ImageBlock；file receipt → FileBlock
       DSH admission 检查模型 inputModalities / 图片上限 / 媒体类型
       拒绝（session/attachment-invalid）→ 文本降级（不重试、不加 ack、落去重键）
  → 去重键持久化 → OK 表情 ack
  → 对除发送者外的绑定 chat 重发 image/file 消息
```

关键点：

- **下载**：`client.im.v1.messageResource.get({path:{message_id, file_key}, params:{type}})` 返回 `getReadableStream()`；插件只读取到 64 字节作为“可嗅探 head”，`data` 迭代器先重放 head 再流式转发剩余字节，保证不丢字节也无需整文件缓冲（图片除外，见下）。文件类型 `type` 是 query 参数，音频/视频都用 `file`。头部嗅探只用于**图片**（文件不需要魔数分类），因此文件全程流式。
- **图片**：为在调用 `uploadImageStream` 前确定 `mediaType`，先把 ≤20 MB 图片整体读入内存；魔数只接受 PNG/JPEG/WEBP/GIF（与 DSH `attachment-local` 的 `mediaTypes` 完全一致）。HEIC/BMP/TIFF/SVG 及其他未知格式直接降级，不进入 DSH。
- **文件**：`collectingStream` 在转发的同时统计总字节（>100 MB 抛 `too-large`）并保留至多 30 MB 副本（超过即丢弃副本），用于后续 Feishu 二次上传；一条消息内所有附件的镜像副本共享 **60 MB** 预算（`MAX_INBOUND_MIRROR_BYTES`），预算用尽后的附件不再保留原始副本：文件镜像降级为占位文本，图片改用 DSH 规范化后的 prompt 副本重传（仍不可用才占位）；因此 100 MB 文件不会在内存里翻倍。
- **prompt 文本**：保留 `[飞书 · label]` 前缀，正文追加占位 `（图片）`/`（文件：name）`/`（音频）`/`（视频：name）`，让文本镜像与其他用户也能理解这条消息带了附件；agent 侧真正的内容来自原生 ImageBlock/FileBlock。
- **附件命名**：文件名只用于 DSH 展示、飞书上传和占位文本，永不拼路径；控制字符与 `/`、`\` 会被清洗，长度截断到 120 字符；无扩展名时文件回退为 `file.bin`、音频回退 `audio.opus`、视频回退 `video.mp4`。
- **DSH 侧上限**：安装版 `attachment-local` 默认 50 MiB/图、20 图/消息、200 MiB/消息；插件把入站图片上限收紧到 20 MB（避免大图长期占用 FIFO 与内存），文件上限 100 MB（飞书单次下载上限）。
- **有界与取消**：单个附件的「下载 + 暂存」链路共 120 秒有界等待（`attachmentTimeoutMs`，可注入测试值），`AbortSignal.any([bridge lifecycle, AbortSignal.timeout(120s)])` 传入 SDK 与 DSH 上传服务，因此 stop/超时会真正中止在途 HTTP 与迭代器；失败的下载会 `cancel()` 释放 stream。镜像/交付物的上传与发送各自有独立的 120 秒等待。
- **为什么不用 `agent/inbox/spliced`**：它是附件 prompt 被接纳的最早信号，但 `user/message` 才是持久的正式消息；现有文本镜像链路已经以 `user/message` 为准，附件镜像在入站处理完成（ack 后）直接发往其他 chat，不依赖额外事件，也不引入跨重启的插件内存状态。

### 11.3 入站降级矩阵

| 触发 | 用户看到 | Session | ack | 去重键 |
| --- | --- | --- | --- | --- |
| 下载失败/网络错误 | `附件下载失败…` | 不投递 | 不加 | 写入 |
| 图片格式 HEIC/BMP/TIFF/SVG/未知 | `图片格式 HEIC 暂不支持，支持 PNG/JPEG/WEBP/GIF…` | 不投递 | 不加 | 写入 |
| 图片 >20 MB / 文件 >100 MB | `附件超过大小限制（图片 ≤20.0 MB，文件 ≤100.0 MB）…` | 不投递 | 不加 | 写入 |
| 无 `fileUploads` 服务（非标准 composition） | `附件无法写入 DSH 附件服务…` | 不投递 | 不加 | 写入 |
| DSH 拒绝（模型无视觉/媒体类型不合法/图片数量或聚合超限） | 模型无视觉时专门提示；其他为 `附件未能被 Session 接收…` | 不投递 | 不加 | 写入 |
| DSH 图片字节/像素/尺寸/格式拒绝（`session/attachment-invalid` 的 `reason`；裸 `AttachmentError` code 作为兜底） | 按 code 给具体提示：超过 DSH 字节上限（单张图片或整条消息合计，提示减少图片数量或压缩）/ 像素或尺寸超限 / 格式不支持 / 图片数据无效 / 图片数量超限 | 不投递 | 不加 | 写入 |
| `present`/内联图片路径不在允许根（Session 工作区或 DSH 附件目录） | `present` 发文本降级（文件名+大小+原因，不含绝对路径）；内联保留原 Markdown | 不涉及 | 不涉及 | 不涉及 |
| 传输级 admission 失败（非附件原因） | 既有 `消息暂时无法投递…` | 不投递 | 不加 | 不写（可重投恢复） |

降级提示统一为 `[Feishu Omni] …` 纯文本，只含格式/大小/原因，不含字节、本机路径或 Secret；降级路径不再调用 prompt，因此不会出现“消息提示失败但 Session 已收到半条”的情况。文本消息路径完全不受影响。

### 11.4 其他绑定用户可见性

- 与文本镜像同规则：**除发送者外的全部绑定 chat** 收到这条图片/文件；发送者本人不回显。
- 图片：优先用原始字节（≤10 MB）调用 `image.create`；>10 MB 时回退到读取 DSH 已规范化的 prompt 副本（`uploadImageStream` 返回的 `image` ref → `attachments.readImage`，DSH 规范化后 ≤4 MB），仍不可用则占位。
- 文件：使用 ≤30 MB 的收集副本 + `file_type` 映射；音频/视频刻意用 `stream`（飞书要求 file_type 与 msg_type 匹配，`opus`/`mp4` 必须配 audio/media 消息，否则 230055）。收集副本与同消息其他附件共享 60 MB 预算（见 11.2）：预算耗尽时文件镜像降级为占位文本，图片优先用 DSH 规范化后的 prompt 副本重传。
- 每个资源只上传一次，跨绑定复用 key；每 chat UUID = `sha256("attach:" + message_id + ":" + chat_id + ":" + index)` 前 40 位；上传/发送失败按可重试码（限频/超时/5xx）指数退避重试，重试耗尽或永久错误后才记日志并降级为 `[图片]` / `[文件: name]` / `[音频]` / `[视频: name]` 文本，不写 Settings 错误、不阻塞其他绑定。
- 只有存在其他绑定时才做镜像上传（单用户场景没有额外 OpenAPI 调用）。

### 11.5 出站交付物（present）

`present` 工具成功时 append `deliverables/presented`（无 `surfaceOp`，log-only），插件显式接受该事件：

```text
deliverables/presented → pendingPresented.set(turn, merge(files))   // 按 path 去重，单 turn 最多 32 个
turn/end(completed) → 先 broadcastAssistant(最终文本，含内联图片改写)
                    → sendDeliverables(files)
                       每个文件：按 cwd 解析相对路径 → realpath 收敛
                          → 真实路径必须位于 Session cwd / DSH 附件根内（严格前缀）
                          → 普通文件、非空 → 读字节（≤50MB）
                         魔数 = PNG/JPEG/WEBP/GIF → 图片路径：≤10MB 直接 image.create，
                           否则/被拒 → attachments.saveImage+readImage 规范化 → image.create
                         其他 → ≤30MB file.create(file_type = pdf/doc/xls/ppt/stream)
                       每个上传一次，然后逐绑定 chat 发送
turn/end(非 completed) → 清空该 turn 的 present 缓冲，不发送
```

- 顺序：同一 turn 内**先**助手卡片、**后**交付物；同一收件人/文件内部串行。
- 传输重试：交付物的 `uploadImage`/`uploadFile`/`sendImage`/`sendFile` 与降级文本都走与卡片相同的“可重试码指数退避、同一 UUID”策略；只有重试耗尽或永久错误才降级为文本。
- 缓冲上限：单 turn 最多保留 32 个 present 文件（`present` 默认每次最多 8 个，但可配置且可多次调用）；超过时记 warning 并丢弃多余文件，不静默扩大内存。
- 迟到的 present：`turn/end` 之后才到达的 `deliverables/presented`（事件重放/乱序）不再缓冲、不投递，只记 warning；已结束 turn 的集合有界（最多 256 条），避免 `pendingPresented` 随历史 turn 常驻。
- 文件名：显示/上传名取 basename、清洗控制字符并截断到 120 字符；截断保留扩展名，无扩展名的文件上传时补 `.bin`（飞书要求 `file_name` 带后缀）。
- UUID：`sha256(turn 事件键 + ":" + chat_id + ":deliverable:" + index)`；发送失败后的文本降级复用同一 UUID。
- 降级提示 `[Feishu Omni] 交付物「name」（大小）未发送：原因`，原因包括文件不存在/不是普通文件/为空/超过 30 MB/读取失败/图片无法规范化/飞书上传失败/发送失败/**文件不在会话工作区或 DSH 附件目录内**；**不发本机路径**（对其他用户没有意义，也避免泄漏本机目录结构）。
- **路径白名单（防注入外发）**：插件用 Node fs 直接读取本地文件、绕过 DSH 沙箱；共享 Session 一旦被 prompt 注入，不能让它把本机任意文件上传给所有绑定飞书用户。因此 `sendDeliverables` 与 inline 改写共用 `src/paths.ts` 的收敛器：① 相对路径按 Session cwd 解析；② `fs.realpath` 解析全部 symlink 并统一 on-disk 大小写；③ 真实路径必须**等于**某个允许根或以其 `根 + path.sep` 开头（不用裸 `startsWith`，避免 `/work-escape` 冒充 `/work`）；④ `stat` 确认普通文件、非空（`realpath` 已消解 symlink）。允许根为 Session cwd 与 DSH 附件根（`ctx.attachments.root` 优先，rc.5 desktop 组合已核对可用；仅在非标准/fixture composition 未暴露 `root` 时退回 `$DSH_HOME/attachments/v1` 约定兜底，该兜底不完整复刻 `resolveDshHome` 语义——不展开 `~`、把空白 `DSH_HOME` 当字面值、忽略显式 `dshHome` 配置）。收敛同样要求**至少一个已知允许根**：cwd 与附件根都不可用时，连绝对工作区路径也一律拒绝（`no-cwd`/`no-roots`，fail closed），不只是相对路径依赖 cwd。symlink 只有指向根内才允许；指向根外一律拒绝。拒绝时 present 只发降级文本（文件名/best-effort 大小/原因），inline 保留原 Markdown；两者都不读取也不上传字节。Agent 要发其它位置的文件，应先把文件复制进 Session 工作区。
- 上传失败/超限只影响该文件与收件人，不阻塞后续文件与其他 chat。
- `present` 的路径通常已经是绝对路径（`ctx.fs.processPath`）；相对路径按 Session cwd 解析。

### 11.6 卡片内联图片改写

助手最终的 Markdown 卡片发送前，插件扫描**行内**图片语法 `![alt](<path>)` / `![alt](path)`：

1. 跳过 fenced code block（与卡片分片相同的 CommonMark 0–3 空格围栏识别）、4 列缩进的 CommonMark 代码块（tab 按 4 列 tab stop 展开；引用块 `>` 与列表项容器内的 4 列缩进同样识别）、行内代码 span（`` `...` ``），以及反斜杠转义的 `\![alt](path)`（奇数个反斜杠为转义，偶数个反斜杠后图片仍生效），避免把示例或字面量当图片；
2. 跳过 HTTP(S)/其它 scheme URL、`#` 锚点、已经是 `img_*` 的引用；
3. 相对路径按 Session cwd 解析（`session.header.cwd` / `working-directory/change`，缺失时退回 `sessionController.list`）；
4. 相对/绝对路径统一 `realpath` 收敛（解析 symlink、统一大小写），真实路径必须严格位于允许根内：Session cwd 或 DSH 附件根（`ctx.attachments.root` 优先，约定兜底见 11.5）；symlink 指向根外一律拒绝；绝对路径同样要求至少一个已知允许根，cwd 与附件根都不可用时拒绝（fail closed）；
5. 必须存在且是普通非空文件、≤50 MB、魔数属于四种图片格式；
6. ≤10 MB 直接 `image.create`；否则或直传被拒时用 `attachments.saveImage` 规范化后重传；
7. 同一真实路径只上传一次，多引用复用同一 `image_key`；
8. 本 turn 的 `present` 列表里已出现的路径（按真实路径比较）**不做内联**（present 会发真正的图片消息，避免同图两处显示）；
9. 任一步失败（不存在/根外/非图片/上传失败/规范化失败）→ 保留原始 Markdown；上传失败或 present 去重时卡片只保留 `![alt](<path>)` 文本，**不含也不会发送本机字节**，这是预期行为；
10. 改写后重新走 `splitAssistantMarkdown`，24 KB 预算与分片/UUID 逻辑不变。

设计取舍：优先保证“不破坏原文”——改写失败时飞书客户端会把它当普通图片链接，最坏显示为破图/路径文本，而不是丢失助手内容；不改写纯文件链接、不自动把 `[说明](<path>)` 的文件推成附件，避免刷屏。

### 11.7 权限、版本发布与缺权限表现

| 能力 | 需要的 scope（任一） | 缺失时表现 |
| --- | --- | --- |
| 接收单聊消息 | `im:message.p2p_msg:readonly` | 收不到消息 |
| 发送 text/interactive/image/file 消息 | `im:message:send_as_bot` / `im:message` / `im:message:send` | 发送失败，日志/状态可见 |
| 下载入站资源 | `im:message` / `im:message:readonly` / `im:message.history:readonly` | 入站附件下载失败 → 发送者收到降级文本，Session 不投递；文本链路正常 |
| 上传图片/文件 | `im:resource` / `im:resource:upload` | 其他绑定镜像与出站交付物降级为占位/文本；入站 prompt 与助手卡片正常 |
| 表情回执 | `im:message.reactions:write_only` / `im:message` | 无 `OK` 表情，仅日志 |

权限范围变更必须**创建新应用版本并发布**（经企业管理员审核）后生效；未发布时表现为对应的 OpenAPI 权限错误（`99991672` 等），插件按“附件失败只降级、不改变连接状态”的策略处理，并在日志中给出可辨识的脱敏摘要。

### 11.8 已知限制与未验证项

见第 7 节第 15–29 条（模型视觉能力、附件永不清理、100 MB/30 MB/10 MB 上限、群聊、GIF 尺寸、`file_type`/`msg_type` 匹配、相对路径与 cwd 滞后、大附件阻塞 FIFO、镜像 best effort）与第 11.4 节的音频/视频按文件发送说明。自动测试不访问真实飞书；以下需要在真实租户人工验收：`im:message:readonly`/`im:resource:upload` 的发布与生效、HEIC/BMP/TIFF 拒绝提示文案、>10 MB 图片规范化后的 Feishu 显示、present 交付物在客户端的渲染（图片预览/文件卡片）、GIF 尺寸边界、附件消息的 UUID 幂等行为、模型视觉能力（上游模型决定）。
