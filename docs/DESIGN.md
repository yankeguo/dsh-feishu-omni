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

## 2. 已核实的 DSH 扩展点

### Host 与 Session

安装版提供：

- `sessionController.list({}, signal)`：列出 attached 和 persisted Session；`ctx.sessions.list()` 仅列 live，所以不采用后者做设置列表。
- `sessionController.prompt({ requestId, sessionId, mode: 'queue', content }, signal)`：向任意普通既有 Session 投递。冷 Session 会 resume，可能返回 writer-held、migration-required 等错误；`accepted` 只表示 inbox admission，不表示模型执行完成。同一 `requestId` 重试会去重。
- `origin: 'subagent'` 需要另一套 `subagents.prompt` 路由，MVP 明确排除，避免把不可续聊子会话误当普通 Session。
- `ctx.on('session/event', …, { global: true })`：显式订阅全局、提交后的持久事件流。只读取已有 `user/message`、`assistant/message`、`turn/end`，不发明插件 Session event type。
- `assistant/message` 是 step 级，不是必然的 turn 最终答复。本实现按 `data.turn` 保存最后一条非空且 `data.interrupted !== true` 的消息，只在对应 `turn/end.reason` 为 `completed` 时广播。对象与字符串两种 reason 形式都支持；`aborted`、`blocked`、`error`、`max-tokens` 等其它结束原因一律不广播，避免把半截文本当成最终回复。
- `user/message.data.source.kind === 'user'` 才是直接人类输入；relay、goal、team 和 DevLead 内部消息使用其它 source kind，不混入共享频道。

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
  → 校验 user + p2p + text/post + event_id/message_id/chat_id/open_id
  → 立即 ACK，实际工作进入单一 FIFO
  → message_id / event_id 任一已处理则忽略
  → 保存或刷新 open_id → chat_id 绑定
  → sessionController.prompt(mode: queue,
       requestId: "feishu-omni:" + message_id,
       text: "[飞书 · label]\n" + text)
  → 接受后才持久化两个去重键
  → 对应 user/message 被 Session 正式接纳后，广播给全部绑定用户（包括发送者）
```

事件 handler 不等待 prompt、模型或 Open API，满足飞书 **3 秒 ACK** 限制。处理前不永久标记 seen，避免参考实现中“标记后执行失败，重投被吞”的问题。接受与写去重键之间若进程崩溃，重投使用同一 DSH `requestId`，由 Session Controller 再挡一次重复输入。

### 出站

```text
绑定 Session 的 session/event
  → user/message(source.kind=user)
       飞书 requestId：原文广播；其它人类输入加 [DSH]
  → assistant/message：按 turn 暂存最后一条非空、未 interrupted 文本
  → turn/end：仅 reason=completed 时广播一次；
     aborted/blocked/error/max-tokens 等丢弃暂存文本
  → 助手回复：按卡片 JSON 预算分片 → 每收件人依次发送
       im/v1/messages(msg_type=interactive，卡片 JSON 2.0 + markdown 元素)
       卡片失败：同 uuid 回退 / 纯文本回退（见第 9 节）
  → 其它消息：每收件人依次发送 im/v1/messages(msg_type=text)
```

飞书事件只接受 `sender_type === 'user'`，因此机器人自己的广播不会再次注入。出站路径只发送，不调用 prompt，不存在“助手回复再次变用户输入”的回路。飞书来源用户消息经 Session 广播是**有意的共享镜像**，不是回环。

助手回复与其它镜像消息分流：只有 `turn/end` 之后的最终助手回复使用 `interactive` 卡片渲染 Markdown；飞书用户消息、`[DSH]` 输入和测试消息继续用 `text`。这样用户随手输入的文本不会被飞书当作 Markdown 解释（例如一个 `#` 或 `*` 开头的句子），同时助手回复获得原生渲染。卡片标题保留 `[助手]`，单条回复不分片时正文即原始 Markdown；多于一条时标题为 `[助手] (i/n)`。

## 4. DevLead 与“同步消息”的边界

MVP 镜像：所有直接人类输入（飞书与 DSH Web）和 lead 的最终助手回复。

不镜像：`agent/assistant-stream`、`assistant/attempt`、工具调用/结果、队列内部记录、goal/team/relay 输入、DevLead 子 Session 的独立事件和中途报告。DevLead 的通知/汇报最终会经 lead 自己的助手正式回复呈现，因此团队仍能看到 lead 向人类提交的总结，但不会收到内部调度噪声。

没有虚构 `devlead/*` 事件 API；分类只依赖实际 `user/message.source`。群聊 @机器人、审批/提问控制和子 Session 注入留待后续单独定义所有权。

## 5. 去重、顺序与发送恢复

- 飞书专属接收文档要求用 `message_id`，通用文档使用 `event_id`；两者都保存，任一重复即忽略。最近 2000 个键持久化，超限 FIFO 淘汰。
- DSH 出站以 `sessionId + seq + type` 做进程内去重。`session/event` 不重放历史，重启后不主动回放旧消息。
- 入站和出站共享一个 FIFO，单个收件人也依次写入；多用户同时发言不会绕过这个队列。
- 非助手消息（用户镜像、`[DSH]`、测试消息）的 UUID 为 `dshfo_ + sha256(event key + chat_id)` 的前 40 个十六进制字符，总长度小于飞书 50 字符限制。重试复用 UUID，不同消息/收件人使用不同 UUID。
- 助手卡片按分片派生 UUID：`event key + chat_id + part:<i>` 哈希后仍为 46 字符；同一分片的卡片重试与纯文本回退**共用同一个 UUID**，利用飞书“相同 UUID 1 小时内至多一条成功消息”的幂等语义防止重复。
- Session prompt admission 与飞书发送默认都最多 3 次尝试，退避 500ms、1s（上限 5s）；prompt 重试复用 DSH `requestId`。最终 admission 失败会向原发送者回一条错误提示。
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

## 8. 自动测试覆盖

fake 测试覆盖：text/post 解析、非法事件、双键去重、prompt 失败重试、并发 FIFO、广播、completed turn 聚合、interrupted 片段与非 completed turn 抑制、DSH/DevLead source 过滤、永久飞书业务码与单收件人失败隔离、稳定 UUID 重试、永久 pending 请求取消、关闭时排队连接、状态原子保存/读取、损坏状态旁置、I/O 错误/非普通文件/超限文件不旁置、读取后按实际字节数复检超限（`stat` 与 `readFile` 之间文件增长）、旁置 rename 失败上抛、初始化前 `update()` 遇旁置恢复后以空状态继续、控制器恢复、并发状态更新、配置连接生命周期、Secret 脱敏、管理 envelope 校验、Client 两个设置 slot 与响应校验。助手卡片部分覆盖：卡片 JSON 2.0 结构与 `[助手]` 标题、单卡不拆分时原文逐字节保留、长回复分片数量/顺序/`(i/n)` 标记、分片 UUID 确定性、每片按含二次转义的请求体估算 ≤24 KB（普通文本与引号/反斜杠密集文本）、代码围栏闭合/重开与未闭合围栏补齐、单行硬切、CRLF 归一、自定义预算、小表格整块保留与大表按行切分不丢行、`230099` 拒绝后同 UUID 纯文本回退且不泄漏卡片 JSON、网络不确定结果同 UUID 重试与回退、`230020`/旧接口 400 限频码与 `11232`/`11233`/`11247` 消息限流码（含 HTTP 400 包裹）可重试且回退分类为 `rejected`、`230002` 永久错误不重试不回退、分片中途永久失败后停止该收件人其余分片、卡片路径 stop 取消、非助手消息仍为 `text`。另以真实 SDK `Client` / `WSClient` 加本地 Axios adapter（无网络）验证 tenant token、text 与 interactive 消息发送、WebSocket endpoint 和 `$return_headers` 的响应解包。

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

- 发送接口未变：`im:message:send_as_bot` 覆盖 `interactive`，`im:message.p2p_msg:readonly` 仍用于收消息。插件没有新增权限申请。
- 旧客户端（<7.20）不渲染 JSON 2.0 正文：标题仍在，正文显示官方升级提示文案。插件不自动降级为 text，因为那正是本次要修复的“Markdown 显示为纯文本”问题；是否支持旧客户端应作为显式配置项，而不是默认行为。
- 未验证项：真实租户下卡片首次发送的权限、真实旧客户端的升级提示样式、单卡 >4 个表格被拒绝（官方未给明确子码，可能为 `230099`）后的回退路径——均需人工验收。
