# dsh-feishu-omni

把一个**既有 DeepSeek Harness（DSH）Session**变成飞书里的共享指挥频道：多位飞书用户向同一个机器人发言，消息进入同一个 Session；该 Session 的人类输入和助手最终回复再广播给所有已绑定用户。

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
- 单聊 `text` 与基础 `post` 文本；
- 首次单聊自动保存 `open_id + chat_id` 绑定；
- 飞书输入以 `[飞书 · 发送者]` 前缀进入所选 Session；
- DSH 网页中的人类输入以 `[DSH]` 前缀同步；
- 每个 turn 的最后一条非空正式助手消息在 `turn/end` 后广播一次；
- `message_id + event_id` 双键持久去重、Session 事件去重、机器人消息防回环；
- 全局 FIFO、指数退避、发送 API `uuid` 幂等、SDK 自动 tenant token 刷新；
- 一个收件人失败不阻塞其他收件人，绑定保留以便重新加回机器人后恢复；
- Secret 存入 DSH credentials；状态接口、设置页和日志不返回明文。

明确不做：群聊、图片/文件/音视频、卡片审批、流式 token、工具进度、消息编辑/撤回、二维码流程、多机器人、多实例高可用。子 Agent Session 也不在选择范围内。

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

然后在 DSH 中打开 **Plugins → Add plugin**，选择这个仓库目录。该目录的 `package.json` 同时声明 Host bundle 与 Web Client；不要运行另一个 DSH 或 Web 服务。

### 配置

打开 **Settings → 飞书 Omni**，或在 **Plugins** 中打开本插件的配置页：

1. 填飞书官方术语所示的 **App ID / App Secret**。Secret 输入框遮罩；保存后输入框清空，留空表示保留已保存 Secret。
2. 点击刷新，从列表选择一个普通 DSH Session。列表包含已加载和持久化的冷 Session，排除 `origin: subagent`。
3. 保存配置，点击**连接**。状态会显示连接中、已连接或最近错误；连接成功后会记住自动连接。
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

## 持久化与隐私

- 非秘密配置、绑定和最近去重键：`$DSH_HOME/integrations/dsh-feishu-omni/state.json`（未设置 `DSH_HOME` 时为 `~/.dsh/...`）。写入采用临时文件原子替换，文件权限 `0600`。
- App Secret：DSH credentials 引用 `DSH_FEISHU_OMNI_APP_SECRET`，由本机 DSH credential provider 保存。
- 管理 RPC 复用 DSH 已认证的 `/api` 通道，不新增端口，不读取或重写 profile 的 `cordis.patch.yml`。
- 仓库、测试夹具、状态响应和插件日志均不应包含真实 Secret。

## 人工验收（需要真实飞书应用）

自动测试不访问真实飞书，也不安装到当前运行中的 DSH。请人工执行：

- [ ] `pnpm install && pnpm run verify` 全部通过。
- [ ] Add plugin 后，插件条目显示名称、说明和图标，无加载错误。
- [ ] 独立 Settings 页面和 Plugin Manager 的 Configure 页面均可打开。
- [ ] 保存无效凭据时出现可理解错误，页面和日志没有 Secret 明文。
- [ ] 保存有效凭据并选择 DevLead lead Session 后，状态变为已连接。
- [ ] 飞书后台可以选择长连接并保存 `im.message.receive_v1` 订阅。
- [ ] 用户 A 私聊后，A 的绑定出现；用户 B 私聊后，A 也能看到 B 进入 Session 的消息。
- [ ] DevLead 的最终回复同时到达 A、B；工具调用和流式 token 不刷屏。
- [ ] 同一消息重复投递不会重复进入 Session；网页中的人类输入也会同步。
- [ ] 断网再恢复后 SDK 自动重连；终态错误可在设置页查看并手动重新连接。
- [ ] 一个会话投递失败不妨碍另一个会话，恢复后下一条消息可再次送达。
- [ ] 断开后飞书消息不再进入 Session，重新连接后恢复。

首次本地目录安装可能通过插件 HMR 生效。**替换已安装包需要重启 DSH**；本仓库的自动验证不会替你重启桌面应用。

## 设计、限制与调查依据

见 [`docs/DESIGN.md`](docs/DESIGN.md)，包括 DSH `0.2.2-rc.5` 的实际 API、消息流、去重/防环、DevLead 取舍、崩溃边界及未验证项。

## License

MIT，见 [`LICENSE`](LICENSE)。
