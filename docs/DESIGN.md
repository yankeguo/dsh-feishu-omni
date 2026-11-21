# 设计与调查记录

## 1. 调查基线

- 运行中的桌面安装版由 `$DSH_INSTALL_DIR/package.json` 确认为 **DSH `0.2.2-rc.5`**。
- 插件签名与事件行为以该安装版 ASAR 内的实际源码为准；开发源码克隆只辅助定位，不作为发布版接口依据。
- 参考实现为 `@xmanrui/dsh-im@5.10.0`。只借鉴接入层，不沿用它的“每个 IM 会话一个 DSH Session”策略。
- 飞书 SDK 固定 `@larksuiteoapi/node-sdk@1.76.0`。官方当前长连接支持企业自建应用，桌面机只需出站公网，不需要公网回调。

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
  → turn/end：仅 reason=completed 时以 [助手] 前缀广播一次；
     aborted/blocked/error/max-tokens 等丢弃暂存文本
  → 每个收件人依次发送 im/v1/messages(receive_id_type=chat_id)
```

飞书事件只接受 `sender_type === 'user'`，因此机器人自己的广播不会再次注入。出站路径只发送，不调用 prompt，不存在“助手回复再次变用户输入”的回路。飞书来源用户消息经 Session 广播是**有意的共享镜像**，不是回环。

## 4. DevLead 与“同步消息”的边界

MVP 镜像：所有直接人类输入（飞书与 DSH Web）和 lead 的最终助手回复。

不镜像：`agent/assistant-stream`、`assistant/attempt`、工具调用/结果、队列内部记录、goal/team/relay 输入、DevLead 子 Session 的独立事件和中途报告。DevLead 的通知/汇报最终会经 lead 自己的助手正式回复呈现，因此团队仍能看到 lead 向人类提交的总结，但不会收到内部调度噪声。

没有虚构 `devlead/*` 事件 API；分类只依赖实际 `user/message.source`。群聊 @机器人、审批/提问控制和子 Session 注入留待后续单独定义所有权。

## 5. 去重、顺序与发送恢复

- 飞书专属接收文档要求用 `message_id`，通用文档使用 `event_id`；两者都保存，任一重复即忽略。最近 2000 个键持久化，超限 FIFO 淘汰。
- DSH 出站以 `sessionId + seq + type` 做进程内去重。`session/event` 不重放历史，重启后不主动回放旧消息。
- 入站和出站共享一个 FIFO，单个收件人也依次写入；多用户同时发言不会绕过这个队列。
- 同一逻辑发送的 UUID 为 `dshfo_ + sha256(event key + chat_id)` 的前 40 个十六进制字符，总长度小于飞书 50 字符限制。重试复用 UUID，不同消息/收件人使用不同 UUID。
- Session prompt admission 与飞书发送默认都最多 3 次尝试，退避 500ms、1s（上限 5s）；prompt 重试复用 DSH `requestId`。最终 admission 失败会向原发送者回一条错误提示。
- 429、408、425、5xx 和网络错误可重试；普通 4xx、认证终态和飞书业务码 `230002`（机器人不在目标会话）不重试。SDK 的非零响应会把业务 `code` 挂到 Error 上，供统一分类；其它未知业务码暂按可重试处理。
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

只有完成旁置的 `StateRecoveryError` 会被吞掉：控制器初始化把它脱敏后继续，`FileStateStore.update()` 在初始化前遇到它也按“已旁置、空状态就绪”继续；其它错误一律向上抛出。

App Secret 仅存在于单次浏览器请求、Host 内存与 DSH credentials。控制器额外用当前 Secret 替换第三方错误消息中的出现次数；Client 保存成功立即清空输入，状态解析器没有 Secret 字段。测试包含 Secret 不出现在状态、RPC 和日志的负向用例。

## 7. 已知限制

1. **不是持久 outbox，不保证崩溃后的 exactly-once。** DSH 已提交但尚未完成飞书发送时若进程崩溃，不会自动补发；飞书至少一次重推与发送 UUID 只覆盖各自的重试窗口。
2. 去重键有容量上限，极旧事件重投可能再次执行。多实例部署需要共享幂等存储和队列，本 MVP 只支持一个 Host 进程。
3. 飞书输入在 DSH queue 中等待时，要等它成为正式 `user/message` 才镜像；这是刻意以 Session 持久事实为准，而不是先显示一个可能投递失败的回声。
4. 长连接保存、权限发布、真实用户姓名、真实重连和机器人被移出会话的提供商错误码只能人工验收；自动测试使用 fake，不声称覆盖真实平台。
5. SDK 的 HTTP 代理、企业网络证书和可用范围策略由部署环境负责。插件不启动第二个 DSH、不修改模型/preset、不打开新端口。
6. `state.json` 是普通本机配置，不是加密数据库；Open ID、chat_id 和 Session ID 会明文保存。Secret 不在其中。
7. 插件替换安装后的 Host JS 需要重启 DSH 才能加载新模块；人工验收由用户执行。

## 8. 自动测试覆盖

fake 测试覆盖：text/post 解析、非法事件、双键去重、prompt 失败重试、并发 FIFO、广播、completed turn 聚合、interrupted 片段与非 completed turn 抑制、DSH/DevLead source 过滤、永久飞书业务码与单收件人失败隔离、稳定 UUID 重试、永久 pending 请求取消、关闭时排队连接、状态原子保存/读取、损坏状态旁置、I/O 错误/非普通文件/超限文件不旁置、读取后按实际字节数复检超限（`stat` 与 `readFile` 之间文件增长）、旁置 rename 失败上抛、初始化前 `update()` 遇旁置恢复后以空状态继续、控制器恢复、并发状态更新、配置连接生命周期、Secret 脱敏、管理 envelope 校验、Client 两个设置 slot 与响应校验。另以真实 SDK `Client` / `WSClient` 加本地 Axios adapter（无网络）验证 tenant token、消息发送、WebSocket endpoint 和 `$return_headers` 的响应解包。

测试边界：`tests/host-adapters.spec.ts` 的 Cordis `Context` 和 Session Controller 全部是 mock，只验证本插件构造的 list/prompt 调用形状；安装版签名兼容性来自对目标 ASAR 源码的只读核对，不等同于真实 Host 集成测试。SDK 测试也只使用本地 HTTP adapter，不验证飞书实际权限、事件投递或 WebSocket 服务行为。依赖 `chmod` 权限位的用例在 root 与 Windows 上自动跳过（Windows 上 chmod 不阻止读取或改名）。

不访问真实飞书，不安装到正在运行的 DSH，不读取真实 credentials，不依赖任何测试 Secret。
