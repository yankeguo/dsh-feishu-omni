# dsh-feishu-omni

把一个**既有 DeepSeek Harness（DSH）Session**变成飞书里的共享指挥频道：多位飞书用户向同一个机器人发言，消息进入同一个 Session；该 Session 的人类输入和助手最终回复再广播给所有已绑定用户，但飞书用户消息不回显给发送者本人。助手最终回复使用飞书卡片渲染 Markdown（标题、列表、代码块、链接、表格），而不是把 Markdown 当纯文本显示。消息成功进入 Session 后，机器人会给原消息加一个固定的 `OK` 表情作为送达回执。

图片和文件双向可用：飞书用户可以直接发图片/文件，图片以 DSH **原生 ImageBlock**、文件以**原生 FileBlock（只读绝对路径）**进入 Session，助手用现有 `Read`/`read_image`/office 工具即可处理；助手也能在卡片里内联显示图片，或用现有 `present` 工具把文件/图片作为交付物发回飞书。**插件不新增任何 agent tool。**

主要用途是配合 **DevLead**：团队成员在同一个 lead Session 中发言，看到彼此进入对话的消息以及 DevLead 的最终回复。

> **安全提示：这是共享控制面，不是只读群聊。** 任何在飞书应用可用范围内、能单聊该机器人的用户，首次发言都会被绑定，并能向所选 Session 提交指令。请限制企业自建应用的可用范围，只绑定给你信任的这些用户共同操作的 Session。出站上传（`present` 交付物与卡片内联图片）只允许读取**绑定 Session 的工作目录**或 **DSH 附件目录**内的文件：路径先做 `realpath` 收敛，再用严格前缀判定边界，目的正是防止 prompt 注入把本机任意文件外发到所有绑定飞书用户；工作区外的文件请让 agent 先复制进工作区。

## 功能特性

- **一个共享 Session，而不是每人一个 Session**：插件复用设置页里选中的**一个既有普通 DSH Session**（不自动创建 Session，排除子 Agent Session），所有飞书单聊共享同一条消息流。飞书输入以 `[飞书 · 发送者]` 前缀进入 Session；DSH 网页中的人类输入以 `[DSH]` 前缀同步给所有绑定用户。
- **发送者不回显**：飞书用户消息的镜像广播给除发送者外的全部绑定用户，发送者本人不再收到自己刚发内容的重复回显，其他人仍能看到；图片/文件镜像遵循同一规则。
- **`OK` 表情回执**：消息成功进入 Session 后，机器人给用户**原始消息**加一个固定的 `OK` 表情。这是 best effort：一次尝试、不重试，失败只记日志，不影响消息投递与广播。
- **Markdown 卡片渲染**：助手最终回复使用飞书卡片 JSON 2.0 的 `markdown` 富文本组件渲染标题、列表、引用、代码块（含语言）、链接和表格，卡片标题保留 `[助手]`。长回复自动分片，用 `(i/n)` 标注顺序；优先在段落/代码围栏边界切分，代码围栏在分片处闭合/重开。卡片被飞书明确拒绝时自动回退为纯文本。
- **图片/文件双向、不新增 agent tool**：入站图片下载并经格式校验后交给 DSH 附件服务，在 Session 中成为**原生 ImageBlock**；文件/音频/视频流式写入附件服务，成为**原生 FileBlock**（只读绝对路径），助手用现有 `Read`/`read_image`/office 工具读取。出站：agent 用现有 `present` 工具交付文件/图片，turn 正常完成后各绑定用户先收到助手卡片、再收到文件/图片消息；助手 Markdown 里的本地图片引用会内联进卡片。`present` 已声明的同一图片不重复显示。
- **可靠性**：重复投递不会重复进入 Session，机器人消息不会回环；断线后自动重连；单个收件人失败不阻塞其他收件人，绑定会保留以便恢复。
- **安全与隐私**：App Secret 存入 DSH credentials，状态接口、设置页和日志不返回明文；非秘密状态（绑定、最近去重键）写入 `state.json`，写入采用临时文件原子替换、权限 `0600`；出站只桥接 Session 工作区或 DSH 附件目录内的普通非空文件，用于防止共享 Session 被 prompt 注入后外发本机任意文件（细节见下文“已知限制”与“持久化与隐私”）。
- **开箱即用的接入**：企业自建应用 + 官方 Node SDK 的 WebSocket 长连接，不需要公网 webhook、内网穿透或二维码流程；只有一个设置页（App ID、App Secret、Session、连接状态、测试消息）。

### 与常见 IM 插件的区别

常见的 DSH IM 接入（包括参考实现 [`xmanrui/dsh-im`](https://github.com/xmanrui/dsh-im)）通常按 IM 用户/会话创建独立 DSH Session。本插件刻意采用相反模型：

- 只选择一个已经存在的普通 DSH Session，不自动创建 Session；
- 所有飞书单聊都复用它，所有绑定用户共享同一条消息流（发送者看不到自己刚发的消息）；
- 不需要二维码、扫码绑定、公网 webhook 或内网穿透；
- 只有一个设置页：App ID、App Secret、Session、连接状态和测试消息。

## 系统要求

| 项目 | 要求 |
| --- | --- |
| DeepSeek Harness | `>=0.2.2-rc.5 <0.3.0`（开发与测试基准 `0.2.2-rc.5`） |
| Node.js | `>=24.9`（从源码构建需要） |
| pnpm | `12.x`（从源码构建需要） |
| 飞书应用 | 企业自建应用，启用机器人能力，申请所需权限并**发布应用版本** |
| 飞书客户端 | **7.20 及以上**（助手卡片使用卡片 JSON 2.0；更低版本只显示标题与升级提示） |
| DSH Session | 一个**普通** Session（子 Agent Session 不在选择范围内）；做 `present` 交付物时其 agent preset 需挂载 `present` 工具（标准 preset 默认有） |
| 网络 | 桌面机只需**出站**访问飞书 OpenAPI/长连接；不需要入站端口、公网回调或内网穿透 |

## 安装

### 从 npm 安装（推荐）

当前发布版本为 **`0.1.0`**（npm `latest`）：

```bash
# 安装与 Release 对齐的精确版本
dsh plugin --profile desktop add @yankeguo/dsh-feishu-omni@0.1.0

# 或省略版本，安装 latest
dsh plugin --profile desktop add @yankeguo/dsh-feishu-omni
```

也可以在 DSH Web 的 **Plugins → Add plugin** 中输入 `@yankeguo/dsh-feishu-omni`。

### 从源码目录安装（开发调试 / 未发布版本）

```bash
git clone https://github.com/yankeguo/dsh-feishu-omni.git
cd dsh-feishu-omni
pnpm install
pnpm build
```

必须先执行上述安装和构建命令：`lib/` 被 `.gitignore` 排除，全新 clone 不含构建产物；不构建会在插件激活时因无法 import `lib/index.js` 而失败。

然后在 DSH 中打开 **Plugins → Add plugin**，在插件 **spec 文本框**中粘贴这个仓库目录的**绝对路径**（例如 `/Users/name/dsh-feishu-omni`），不要使用相对路径；这个版本没有目录选择器。该目录的 `package.json` 同时声明 Host bundle 与 Web Client；不要运行另一个 DSH 或 Web 服务。

首次从源码目录安装可能因 `@larksuiteoapi/node-sdk` 的传递依赖 `protobufjs` 报 `ERR_PNPM_IGNORED_BUILDS`，安装对话框会显示“有依赖的安装脚本需要你允许后才能继续”并列出待批准的脚本。点击**“允许这些脚本并重试”**即可继续；不要为此修改依赖版本。

> **替换/升级已安装的插件版本需要重启 DSH**；从源码目录安装时修改代码后要先 `pnpm build` 再重启，新的 Host JS 与助手卡片改动才会在运行中的进程里生效。

## 飞书应用配置

1. 在[飞书开放平台](https://open.feishu.cn/)创建**企业自建应用**。
2. 在“应用能力”中启用**机器人**。
3. 在“权限管理”申请权限：图片/文件功能的最小权限组合见下方“权限清单”，只想要文本功能时前三项即可。

4. 在“事件订阅”中添加**接收消息 v2.0**（`im.message.receive_v1`），订阅方式选择**使用长连接接收事件**。如果后台保存长连接方式时要求已有在线连接，先完成上面的安装，并在下面的“插件配置”中点击“连接”，保持连接后再保存。
5. 按企业要求创建并发布应用版本，等待权限和事件配置生效。将机器人加入你的飞书联系人/可用范围；目前只需单聊机器人。**权限变更必须创建并发布新应用版本才生效**。缺权限时不影响文本链路，只是对应能力降级：

   - 缺 `im:message.reactions:write_only`：没有 `OK` 回执，消息流正常，日志出现可识别的权限警告；
   - 缺 `im:message:readonly`：用户发来的图片/文件无法下载，发送者收到明确的降级提示、Session 不收到该附件，文本消息与助手卡片完全正常；
   - 缺 `im:resource:upload`：其他绑定用户的图片/文件镜像与出站交付物降级为占位/文本提示，入站 prompt 与助手卡片不受影响。

**权限清单（最小组合）**

| 权限 | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收单聊用户消息 |
| `im:message:send_as_bot` | 以机器人身份发送消息（含 `text`/`interactive`/`image`/`file`） |
| `im:message.reactions:write_only` | 给用户原始消息添加 `OK` 表情回执 |
| `im:message:readonly` | 下载消息中的图片/文件资源（任一 `im:message` / `im:message:readonly` / `im:message.history:readonly` 可替代） |
| `im:resource:upload` | 上传图片/文件（任一 `im:resource` / `im:resource:upload` 可替代） |

只想要文本功能时，前三项即可；图片/文件功能需要后两项。

`im:message`（获取与发送单聊、群组消息）是更宽的权限。按官方文档的“开启任一权限即可”关系，[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)可用 `im:message` 替代 `im:message:send_as_bot`，[添加消息表情回复](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)可用 `im:message` 替代 `im:message.reactions:write_only`，[获取消息中的资源文件](https://open.feishu.cn/document/server-docs/im-v1/message-resource/get)可用 `im:message` 替代 `im:message:readonly`；但[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)的单聊权限仍按官方文档使用 `im:message.p2p_msg:readonly`，上传资源则需要独立的 `im:resource`/`im:resource:upload`。也就是说 `im:message.p2p_msg:readonly` + `im:message` + `im:resource:upload` 三项也可以工作。群聊的 `group_at_msg` 等权限目前不需要。

官方依据：[长连接配置](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)、[接收消息事件与权限](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[发送消息 API](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[添加消息表情回复 API](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)、[表情文案说明](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce)。

## 插件配置

打开 **Settings → 飞书 Omni**，或在 **Plugins** 中打开本插件的配置页：

1. 填写飞书开放平台中的 **App ID / App Secret**。Secret 输入框遮罩；保存后输入框清空，留空表示保留已保存 Secret。
2. 点击刷新，从列表选择一个普通 DSH Session。列表包含已加载和持久化的冷 Session，排除子 Agent Session。
3. 保存配置，点击**连接**。状态会显示连接中、已连接或最近错误；点击连接即会记住自动连接（下次启动 DSH 自动重试），因此即使本次连接随后失败，下次启动也会重试。
4. 让第一位飞书用户单聊机器人一句话，自动建立绑定。之后可用“发送测试消息”检查所有绑定用户的投递。
5. 其他用户分别单聊机器人，即加入同一个共享消息流。

“断开”会关闭长连接并禁用下次启动时的自动连接；凭据和绑定不会删除。

## 使用方法

### 消息流示例

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

### 谁能看到什么

| 消息 | 广播范围 |
| --- | --- |
| 飞书用户消息镜像（文本） | 除发送者外的全部绑定用户；发送者本人不回显 |
| 飞书用户图片/文件镜像 | 除发送者外的全部绑定用户；二次上传失败时用 `[图片]`/`[文件: name]` 占位文本 |
| DSH 网页人类输入的 `[DSH]` | 全部绑定用户 |
| 助手最终回复 | 全部绑定用户，使用助手卡片渲染 |
| `OK` 表情回执 | 加在用户**原始消息**上（消息成功进入 Session 后；一次尝试、不重试） |

发送者不回显是**可见性优化，不是把共享频道改成单聊**：其他绑定用户仍能看到这条消息，助手回复仍广播给所有人。可见性优先：解析不出发送者时宁可偶发一次回显，也不丢消息。

### 助手回复的显示

- 助手**最终回复**使用 `interactive` 卡片（卡片 JSON 2.0 的 `markdown` 组件）渲染标题、加粗/斜体/删除线、链接、有序/无序列表、引用、代码块（含语言）、表格、分割线等；卡片标题固定带 `[助手]`。
- 长回复按飞书请求体上限分片，多条时标题为 `[助手] (i/n)`；分片优先在段落/代码围栏边界切分，代码围栏在分片处闭合/重开，内容不丢失。
- 飞书用户消息、`[DSH]` 人类输入和测试消息保持纯文本，不把用户随手输入当 Markdown 解释。
- 卡片被飞书明确拒绝（例如内容非法、消息体超长）时，用同一个 `uuid` 回退为纯文本 `[助手] …`，尽量保证消息不丢。
- 飞书客户端低于 **7.20** 时：卡片标题仍显示，正文显示官方的“升级客户端”提示；这是卡片 JSON 2.0 的固有代价（2.0 才支持列表、代码块和表格）。

### 图片与文件

**入站（飞书 → Session）**

- 支持单聊 `image`、`file`、`audio`、`media` 消息，以及 `post` 富文本里的文本/标题与 `img`（图片）、`media`（视频）节点。
- **图片**：下载后按文件头魔数识别 PNG/JPEG/WEBP/GIF（其它格式不接受，HEIC/BMP/TIFF/SVG 会收到明确提示），交给 DSH 附件服务暂存，在 Session 中成为**原生 ImageBlock**。模型是否支持视觉由 DSH 检查；不支持时发送者会收到文本提示。
- **文件/音频/视频**：流式写入 DSH 附件服务，成为**原生 FileBlock**（只读绝对路径）；助手用现有 `Read`/`Bash`/office/`read_image` 工具处理，不需要新工具。
- prompt 文本保留 `[飞书 · 发送者]` 前缀，并附占位：`（图片）`、`（文件：name）`、`（音频）`、`（视频：name）`。
- 附件字节由 DSH 附件服务内容寻址保存，不经过插件自管目录，也不进日志。

**出站（Session → 飞书）**

- **交付物（`present`）**：agent 用现有 `present` 工具交付文件/图片；turn 完成后各绑定用户**先收到助手卡片、再收到文件/图片消息**（图片显示为图片消息，不是文件）。每个文件只上传一次、跨绑定复用。
- **卡片内联图片**：助手最终回复里形如 `![说明](<path>)` / `![说明](path)` 的**本地**图片会被上传为飞书 `image_key`，并内联显示在卡片里；HTTP(S) URL、代码块/行内代码内的引用、不存在或上传失败的引用原样保留；`present` 已声明过的同一路径不会再内联（避免同一张图显示两次）。纯 Markdown 文件链接（`[说明](<path>)`）不会自动推送。
- **出站路径范围（防注入外发）**：`present` 交付物与卡片内联图片**只读取绑定 Session 的工作目录或 DSH 附件目录内的普通非空文件**，根外文件不读取、不上传。工作区外的文件不会被打包上传：`present` 改为只含文件名/大小/原因的文本降级（不含本机路径），卡片内联图片则保留原 Markdown 文本。其它位置的文件请让 agent 先复制进 Session 工作区。
- `present` 依赖绑定 Session 的 agent preset（标准 preset 默认挂载；minimal preset 可能没有）；没有 `present` 时，助手仍可用 Markdown 图片引用内联显示图片。

**大小限制与降级**

| 方向 | 类型 | 上限 / 规则 | 超过或失败时 |
| --- | --- | --- | --- |
| 入站 | 图片 | 插件 20 MB；仅 PNG/JPEG/WEBP/GIF | 向发送者发明确文本提示，不进入 Session、不加 `OK`；文本消息不受影响 |
| 入站 | 文件/音频/视频 | 100 MB（飞书资源下载上限） | 同上 |
| 入站 | 其他绑定用户镜像 | 图片 ≤10 MB 直接重传，>10 MB 用 DSH 规范化后的副本；文件 ≤30 MB | 降级为 `[图片]`/`[文件: name]` 文本，仅日志 |
| 出站 | 图片交付物 / 内联图片 | 飞书 ≤10 MB；GIF ≤2000×2000、其他 ≤12000×12000 | 超限时经 DSH 规范化后重试；仍失败 → 文本降级 / 保留原 Markdown |
| 出站 | 文件交付物 | 飞书 ≤30 MB | 超限或上传失败 → 文本降级 |

降级提示只包含文件名/类型/大小/原因，不包含本机绝对路径、字节或 Secret。

## 已知限制

- **仅单聊**：不支持群聊；群 @ 机器人、合并转发、卡片消息里的资源也不处理。只支持一个共享 Session，子 Agent Session 不在选择范围内。
- **明确不做**：群聊、交互式卡片按钮/卡片审批、流式 token、工具进度、消息编辑/撤回、二维码流程、多机器人、多实例高可用、附件自动清理、>100 MB 资源下载（飞书需要 Range 分片）、音频/视频的内联播放。表情回执只做固定 `OK` 的送达回执，不做自定义表情、表情统计或删除。
- **没有流式体验**：只广播每个 turn 的最后一条正式助手回复；取消、失败、受阻和 `max-tokens` 截断的 turn 不广播。
- **客户端版本**：助手卡片需要飞书客户端 **7.20+**，更低版本只显示标题与升级提示。
- **附件不自动清理**：入站与出站规范化的字节存入 DSH 附件服务（`$DSH_HOME/attachments/v1`，内容寻址；未设置 `DSH_HOME` 时为 `~/.dsh/attachments/v1`），DSH 与插件都不会自动删除，长期使用需自行清理；清理后历史 FileBlock 的只读路径会失效。
- **资源大小**：>100 MB 的资源下载不支持（飞书需 Range 分片）；入站图片插件上限 20 MB、文件上限 100 MB；出站图片上限 10 MB、文件上限 30 MB，超限或上传失败时降级为文本提示。
- **大附件阻塞共享队列**：附件下载/暂存/上传在单一 FIFO 内完成，单个大附件会推迟其他用户的消息与助手回复。
- **单进程、无持久 outbox**：DSH 已提交但尚未完成飞书发送时若进程崩溃，不会自动补发；去重键有容量上限，极旧事件重投可能再次执行；不支持多实例部署。
- **镜像与表情回执为 best effort**：其他绑定用户看到的图片/文件依赖同一应用重新上传；缺 `im:resource:upload`、超限或重试耗尽时降级为占位文本。`OK` 回执失败只记日志。
- **回显抑制兜底**：升级后首次重放旧格式消息、或发送者绑定在 prompt 与事件之间被刷新等边缘情况，可能偶发一次回显；正常新消息不回显，其他用户的可见性始终优先。
- **模型视觉能力**：图片是否真正被理解取决于所选上游模型的 `inputModalities`；模型不支持图片时插件给发送者文本提示，Session 不接收该附件。
- **`present` 依赖 preset**：出站交付物要求绑定 Session 的 agent preset 挂载了 `present`；minimal preset 可能没有，但助手 Markdown 内联图片仍可用。
- **出站路径范围**：`present` 交付物与卡片内联图片只允许 Session 工作区或 DSH 附件目录内的文件；其它位置需先复制进工作区，否则 `present` 只收到不含本机路径的降级提示，内联图片保留原 Markdown。
- **单 turn 交付物上限**：一个 turn 最多桥接 32 个 `present` 文件（`present` 默认每次最多 8 个，可多次调用）；超出部分跳过并记日志。

## 持久化与隐私

- 非秘密配置、绑定和最近去重键：`$DSH_HOME/integrations/dsh-feishu-omni/state.json`（未设置 `DSH_HOME` 时为 `~/.dsh/...`）。写入采用临时文件原子替换，文件权限 `0600`；文件内容损坏时会被旁置为 `state.json.corrupt-*` 并以空状态启动（设置页会显示恢复信息），原文件不会直接删除。
- App Secret：存入 DSH credentials（引用名 `DSH_FEISHU_OMNI_APP_SECRET`），由本机 DSH credential provider 保存；状态接口、设置页和日志不返回明文。
- 附件字节：入站由 DSH 附件服务按内容寻址保存（`$DSH_HOME/attachments/v1`），**永不自动清理**；出站图片需要规范化时也写入同一服务。插件不建自己的附件目录，日志只记录资源 key/文件名/大小/脱敏错误摘要，不记录字节或 Secret。
- 出站路径白名单：`present` 交付物与卡片内联图片只读取 Session 工作区或 DSH 附件目录内的普通非空文件（`realpath` 解析 symlink + 严格前缀边界，根外一律拒绝）。根外文件不读取、不上传：`present` 只发不含本机路径的降级文本，卡片内联图片保留原 Markdown。
- 插件不新增监听端口；管理请求复用 DSH 已有的认证通道，不读取或重写 profile 配置。

## 常见问题与故障排查

| 现象 | 处理 |
| --- | --- |
| 设置页保存成功，但点击连接后失败 | 检查 App ID/App Secret、机器出站网络、飞书应用是否已发布、长连接方式是否被企业策略限制；看设置页“最近错误”后重试。凭据错误不会在页面或日志里显示 Secret 明文。 |
| 飞书发消息后 Session 没有反应 | 确认是**单聊**机器人（不支持群聊）、应用版本已发布、事件订阅为 `im.message.receive_v1` 且使用长连接、绑定 Session 仍存在且未被删除。 |
| 收到「消息暂时无法投递」提示 | 消息没有成功进入绑定的 DSH Session：检查绑定的 Session 是否仍存在、DSH 是否在运行、队列是否被占满，稍后重发即可；插件会自动重试可恢复的投递失败。 |
| 消息进入了 Session，但没有 `OK` 表情 | 缺少 `im:message.reactions:write_only`（或更宽的 `im:message`），或权限已加但**没有发布新应用版本**。消息投递与广播不受影响，日志有权限警告。 |
| 发图片/文件后 Session 没收到附件 | 缺少 `im:message:readonly`（或 `im:message`）或未发布新版本；格式不是 PNG/JPEG/WEBP/GIF（HEIC/BMP/TIFF/SVG 不支持）；图片 >20 MB 或文件 >100 MB；所选模型不支持图片输入。发送者会收到具体文本提示。 |
| 其他绑定用户收不到我发的图片/文件 | 缺少 `im:resource:upload`（或 `im:resource`）或未发布新版本；图片 >10 MB 且无规范化副本、文件 >30 MB，或重试耗尽，此时降级为占位文本。 |
| 助手回复在飞书里显示成纯文本/升级提示 | 飞书客户端低于 **7.20**，卡片 JSON 2.0 正文无法渲染（标题仍在）。升级客户端即可。 |
| 助手回复被拆成多条 | 正常行为：长回复按请求体上限分片，标题显示 `[助手] (i/n)`，按顺序阅读即可。 |
| 助手 `present` 的文件/图片没有发出来 | 检查绑定 Session 的 preset 是否挂载 `present`；文件是否在 Session 工作区或 DSH 附件目录内、是否存在/为空；文件 >30 MB、图片 >10 MB 或上传失败会变成文本降级提示。 |
| 卡片里的内联图片不显示 | 路径不在 Session 工作区或 DSH 附件目录内、不是 PNG/JPEG/WEBP/GIF、文件不存在或上传失败时，卡片保留原 Markdown 文本（可能显示为破图或路径）。 |
| 从源码安装后插件激活失败 | 全新 clone 必须先 `pnpm install && pnpm build`（`lib/` 不在仓库里）；安装时若报 `ERR_PNPM_IGNORED_BUILDS`，点击“允许这些脚本并重试”。 |
| 升级/替换插件后行为没变 | Host JS 与助手卡片改动需要先 `pnpm build`（源码安装），再**重启 DSH**；首次目录安装可能由插件 HMR 生效，但替换已安装包必须重启。 |
| 机器人被移出/停用后收不到消息 | 绑定会保留；机器人恢复可用后，后续消息会再次投递。 |
| 偶发一次自己的消息被回显 | 已知边缘情况（旧格式消息重放或绑定刷新），正常新消息不回显；见下文“已知限制”中的“回显抑制兜底”。 |
| 想重置插件状态 | 先在设置页“断开”可停止连接但保留凭据与绑定；需要彻底重置时，关闭 DSH 后删除 `$DSH_HOME/integrations/dsh-feishu-omni/state.json`，再重新配置（App Secret 在 DSH credentials 中管理）。 |
| `dsh plugin ... add @yankeguo/dsh-feishu-omni@<版本>` 报找不到版本 | 该版本尚未发布到 npm（或尚未 approve）。安装已发布的 `0.1.0`（或省略版本安装 latest）；未发布版本请从源码目录安装。 |

## 更多文档

- [设计与内部机制](https://github.com/yankeguo/dsh-feishu-omni/blob/main/docs/DESIGN.md)：消息流、去重/恢复、回显抑制与表情回执、卡片与附件的实现细节、已知限制与自动测试覆盖。
- [发布指南](https://github.com/yankeguo/dsh-feishu-omni/blob/main/docs/PUBLISHING.md)：维护者的发布/CI 流程、首次 bootstrap、trusted publisher 与故障恢复。
- [人工验收清单](https://github.com/yankeguo/dsh-feishu-omni/blob/main/docs/ACCEPTANCE.md)：真实飞书租户下的端到端验收项。
- [开发指南](https://github.com/yankeguo/dsh-feishu-omni/blob/main/docs/DEVELOPMENT.md)：仓库结构、本地构建/测试、CI 与文档约定。
- [版本发布说明](https://github.com/yankeguo/dsh-feishu-omni/tree/main/docs/releases)（[GitHub Releases](https://github.com/yankeguo/dsh-feishu-omni/releases)）：各版本的功能、限制与验证证据。
- [第三方依赖与许可说明](https://github.com/yankeguo/dsh-feishu-omni/blob/main/THIRD_PARTY_NOTICES.md)；问题反馈请开 [GitHub Issue](https://github.com/yankeguo/dsh-feishu-omni/issues)。

## License

MIT，见 [LICENSE](https://github.com/yankeguo/dsh-feishu-omni/blob/main/LICENSE)。
