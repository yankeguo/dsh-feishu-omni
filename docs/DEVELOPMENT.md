# 开发指南

本文面向**贡献者 / 维护者**：仓库结构、本地开发、构建与测试、CI 约定。插件使用者请先读
[README](../README.md)；发布流程见 [PUBLISHING.md](PUBLISHING.md)；真实飞书租户下的验收
见 [ACCEPTANCE.md](ACCEPTANCE.md)。

## 1. 仓库结构

本仓库是**单包仓库**：根 `package.json` 就是唯一发布物
`@yankeguo/dsh-feishu-omni`（一个 DSH bundle 插件：Host bundle + Web Client），没有
workspace。

| 路径 | 内容 |
| --- | --- |
| `src/` | Host 插件源码（入站/出站桥接、会话状态、卡片、附件、路径收敛、管理 RPC 等） |
| `src/client/` | Web Client（设置页与插件配置页），由 esbuild 打成 `lib/client.js` |
| `tests/` | Vitest 用例（fake 飞书网关、fake Session、临时目录） |
| `scripts/build-client.mjs` | 构建 Web Client，产出带 `__ModuleLoader__` 包装的 `lib/client.js` |
| `scripts/check-package.mjs` | 构建后校验入口与 bundle patch（`pnpm build` 的一部分） |
| `scripts/check-packages.mjs` | 单包发布不变式校验（见 `pnpm run check:packages`） |
| `scripts/stage-release.mjs` | 打包 + `npm stage publish`（CI 与本地预检共用） |
| `scripts/trusted-publishers.sh` | 一次性配置 npm trusted publisher（stage-only） |
| `docs/` | 设计、发布、开发、验收文档与 `docs/releases/` |
| `locale/en.json`、`locale/zh.json` | DSH 插件管理器/市场展示用的标题与描述（随包发布） |
| `cordis.patch.yml` | DSH bundle 挂载补丁 |
| `.github/workflows/` | `verify.yml`（持续校验）与 `publish.yml`（只 stage） |

构建产物 `lib/` 与 `node_modules/` 都在 `.gitignore` 里，仓库不提交构建产物。

## 2. 环境要求

- **Node.js** `>=24.9`（CI 使用 Node 24）；
- **pnpm** `12.x`（CI 固定 `12.16.1`）；
- **npm** `>=11.20.0`（只有 `pnpm run release:dry` / `release:stage` 需要 staged publishing）；
- 开发基准 **DSH `0.2.2-rc.5`**（`engines.dsh` = `>=0.2.2-rc.5 <0.3.0`）；升级 DSH
  小版本时按 [PUBLISHING.md](PUBLISHING.md) 的兼容性要求回归。

## 3. 获取与构建

```bash
git clone https://github.com/yankeguo/dsh-feishu-omni.git
cd dsh-feishu-omni
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` = `tsc -p tsconfig.build.json` → `scripts/build-client.mjs` →
`scripts/check-package.mjs`，产出 `lib/`（Host JS/d.ts 与 Web Client bundle）。全新 clone
不含 `lib/`，**不构建就无法在 DSH 中加载插件**。

首次安装可能因 `@larksuiteoapi/node-sdk` 的传递依赖 `protobufjs` 报
`ERR_PNPM_IGNORED_BUILDS`：在安装对话框点击“允许这些脚本并重试”即可继续；不要为此修改
依赖版本。

## 4. 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm run lint` | ESLint（`src`、`tests`、`scripts`、配置） |
| `pnpm run typecheck` | `tsc --noEmit` 全量类型检查 |
| `pnpm test` / `pnpm run test:watch` | Vitest 单次 / watch |
| `pnpm build` | 构建 Host 与 Web Client，并校验入口 |
| `pnpm run verify` | 一次执行 lint + typecheck + test + build（本地与 CI 同一入口） |
| `pnpm run check:packages` | 单包发布不变式（manifest/engines/files/exports/locale/icon/依赖放置/构建产物/lockfile/CI pin/发布说明） |
| `pnpm run release:dry` | 本地打包 + `npm stage publish --dry-run` 预检（不上传、不创建 stage id） |
| `pnpm run release:stage` | 本地 stage 一个版本（需要 `npm login`，CI 不使用） |

测试全部使用 **fake 飞书网关、fake Session 和临时目录**，不需要真实凭据，也不访问真实
飞书；用例覆盖范围见 [DESIGN.md](DESIGN.md) 第 8 节。CI（`verify.yml`）在 Node 24 上执行
同一组检查：`pnpm install --frozen-lockfile` → `pnpm run verify` →
`pnpm run check:packages`。

## 5. CI 与发布

- [`verify.yml`](../.github/workflows/verify.yml)：push 到 `main`、PR（及手动 dispatch）
  触发；只读权限，不接触 registry，不创建 Release。
- [`publish.yml`](../.github/workflows/publish.yml)：推送 `v*` tag（或 workflow_dispatch
  指定**已存在**的 tag）触发；安装、typecheck、test、build、`check:packages` 后用
  `node scripts/stage-release.mjs` **只 stage、不发布**。维护者在 npmjs.com 网页 approve
  后**手动**创建 GitHub Release；CI 不创建/移动/删除 tag，也不创建 Release。
- 仓库**没有** promote / 直发脚本。
- 完整的发布模型、首次 bootstrap、脚本参考与故障恢复见
  [PUBLISHING.md](PUBLISHING.md)。

CI 状态（`main`）：

[![verify](https://github.com/yankeguo/dsh-feishu-omni/actions/workflows/verify.yml/badge.svg)](https://github.com/yankeguo/dsh-feishu-omni/actions/workflows/verify.yml)

## 6. 开发约定

- **不要提交构建产物**：`lib/` 被 gitignore，每次发布都重新构建；`package.json` 的
  `prepack` 会在打包前触发构建。
- **依赖放置**：DSH host 包必须是 `peerDependencies`（linked-root 解析），并且同时装进
  `devDependencies` 供 typecheck；运行依赖只保留评审过的固定版本
  （`@larksuiteoapi/node-sdk@1.76.0`、`axios@1.16.0`）。`check:packages` 会强制这些约束。
- **兼容范围**：`engines.dsh` 是精确范围 `>=0.2.2-rc.5 <0.3.0`，改动需配套回归，不能为了
  通过检查而放宽。
- **文档约定**：
  - [README](../README.md) 只面向插件使用者（是什么、要求、安装、配置、使用、限制、FAQ），
    开发/发布/验收内容放在 `docs/`；
  - README **不加 YAML frontmatter**：npmjs.com 不渲染 frontmatter，会把 `---` 元数据块
    当正文；
  - README 里指向仓库文档/图片的链接必须用**绝对 GitHub URL**（npm 页面无法解析仓库相对
    路径）；`docs/` 内部的相对链接在 GitHub 上正常，可以继续使用；
  - 开发内容有变化时同步 `docs/`，并保持 README 的“更多文档”索引有效。
- **日志与隐私**：仓库、测试夹具、状态响应和插件日志**均不得包含真实 Secret**；本插件自身的文件系统错误只记错误码（如 `ENOENT`），不记绝对路径（第三方库回传的错误摘要无法完全保证，需按脱敏摘要处理）。
- **提交信息**：沿用现有风格（如 `fix(attachments): …`、`docs: …`、`ci(release): …`）。

## 7. 文档地图

| 文档 | 面向 | 内容 |
| --- | --- | --- |
| [README](../README.md) | 使用者 | 功能、要求、安装、飞书应用与权限、设置页、使用与限制、FAQ |
| [DESIGN.md](DESIGN.md) | 开发者 | 调查基线、消息流、去重/恢复、已知限制、卡片/回执/附件内部机制、自动测试覆盖 |
| [PUBLISHING.md](PUBLISHING.md) | 维护者 | 发布模型、首次 bootstrap、trusted publisher、正常发版流程、故障恢复 |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 验收者 | 真实飞书租户下的人工验收清单与记录要求 |
| [releases/](releases/) | 使用者/维护者 | 各版本 release notes 与验证证据 |

## 8. 安装到 DSH 与验收

- 从源码目录安装（开发调试）：按 [README](../README.md) 的“从源码目录安装”执行
  `pnpm install && pnpm build`，然后在 DSH 的 **Plugins → Add plugin** 粘贴仓库绝对路径；
  **替换已安装包后需要重启 DSH** 才会加载新的 Host JS。
- 首次安装/升级后的真机验证按 [ACCEPTANCE.md](ACCEPTANCE.md) 执行；自动化校验只需
  `pnpm run verify && pnpm run check:packages`（可选 `pnpm run release:dry`）。
