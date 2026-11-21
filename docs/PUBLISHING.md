# 发布指南

本仓库是**单包仓库**：根 `package.json` 就是唯一可发布包
`@yankeguo/dsh-feishu-omni`（一个 DSH bundle 插件：Host bundle + Web Client，把一个
既有 DSH Session 接入飞书单聊共享频道，支持文本/图片/文件双向）。没有 workspace
依赖，发布工具链固定为：**pnpm 打包 → npm CLI staged publishing（CI，只 stage）→
维护者在 npmjs.com 网页批量 approve → approve 后手动创建 GitHub Release**（新包的
第一个版本例外：由维护者**人工 staged publish**，见第 3 节）。仓库
**没有** promote 脚本，也没有任何直发脚本：`scripts/check-packages.mjs` 会断言
`release:promote` / `release:publish` 与 `scripts/promote-release.mjs` 不存在，
审批只能在 npmjs.com 网页由人完成。

> **当前状态（2026-11-21，发布之前）**
>
> - npm 上**尚不存在**该包：`npm view @yankeguo/dsh-feishu-omni version` 返回
>   **E404**，没有任何已发布版本，也就没有 `latest` / `next` dist-tag；
> - `0.1.0` 是首个稳定版，**尚未公开**；`v0.1.0` 的 annotated tag 已由维护者在本地
>   准备，**尚未 push** 到 `origin`；
> - **从未创建过 GitHub Release**；
> - 因此现在**不能**用 `dsh plugin ... add @yankeguo/dsh-feishu-omni` 从 npm 安装
>   （registry 上没有这个包），只能按 [README](../README.md) 的“从源码目录安装”；
> - **第一次发布前必须先完成第 3 节的 bootstrap**：npm 已拒绝占位版本，首个版本
>   `0.1.0` 只能由维护者**人工 staged publish**（本机 `npm stage publish` + npmjs.com
>   网页 approve），再配置 trusted publisher，并在推送 `v0.1.0` tag 前临时禁用
>   `publish` workflow（避免 CI re-stage 已发布版本）；完成之后后续版本才走
>   tag → CI stage 的自动流程；
> - CI **不会**自动发布，也**不会**创建 GitHub Release；approve 只在 npmjs.com
>   网页人工完成（登录 + 2FA），approve 即公开且不可撤销。

本文档本身随包发布：`package.json` 的 `files` 包含 `docs`，`scripts/stage-release.mjs`
会断言 tarball 内存在 `package/docs/PUBLISHING.md`。

## 1. 发布模型：CI 只 stage，维护者网页 approve，再手动出 GitHub Release

发布分为三个明确阶段：

| 阶段 | 执行者 | 认证 | 动作 |
| --- | --- | --- | --- |
| **1. Stage（暂存）** | [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)（push `v*` tag 或手动 dispatch 指定已存在 tag） | GitHub Actions OIDC 短时 token（`id-token: write`） | 安装、typecheck、test、build、`check:packages`，然后 `npm stage publish` 上传本包的**暂存**版本。**不发布任何东西。** |
| **2. Approve（批准 = 发布）** | 仓库维护者，在 **npmjs.com 网页**操作 | npmjs.com 账号登录 + 账号 2FA（浏览器会话内完成） | 在 **Staged packages / pending approvals** 页面勾选并批量 approve staged 版本；approve 的那一刻版本立即公开，**不可撤销** |
| **3. Release（GitHub Release）** | 维护者，或 approve 后由维护者通知的 agent | `gh auth login`（有仓库权限） | `gh release create <tag> --repo yankeguo/dsh-feishu-omni --title <tag> --notes-file docs/releases/v<version>.md --verify-tag`；只对**已存在**的 tag 建 Release，**绝不创建/移动 tag** |

> **例外：新包第一个版本（本仓库 `0.1.0`）不走 CI stage**，而是由维护者**人工
> staged publish** 真实版本并在网页 approve（第 3 节的一次性 bootstrap），推 tag 前
> 还会临时禁用 `publish` workflow；从 `0.1.0` 之后的版本开始才使用上表的 CI stage
> 流程。

这样设计的原因：

- **坏包永不外泄**：版本在 stage 完成并且人工 approve 之前不会公开。构建失败、CI
  中途失败、版本/tag 错位都不会让用户装到坏版本。
- **CI 没有发布权**：工作流不持有任何长期 npm token，只有短时 OIDC token；npm 只在
  `npm stage publish` / `npm publish` 时接受 OIDC token，`npm stage list/approve/reject`
  **只能由人类登录执行**。常规路径是在 npmjs.com 网页完成批准（同样要求人类登录 +
  2FA）；即使工作流被篡改，最多也只能 stage 一个未批准的版本。
- **可重跑、可审计**：stage 产物带 provenance；审批前的 stage id 打印在 CI 日志与
  job summary 里；approve 可在 npmjs.com 的 staged/published 记录与 registry 中核对。
- **审批在网页、发布说明手动**：网页支持一次勾选多个 staged 版本批量 approve；GitHub
  Release 只是对既有 tag 的“发布说明载体”，由人在 approve 后决定何时创建。

**tag 约定（硬性）**：CI 永不创建、移动或删除 tag；tag 由维护者本地创建并推送。
approve 后的 GitHub Release 用 `gh release create ... --verify-tag` 手动创建，只引用
已存在的远端 tag。重跑失败流程时用 `workflow_dispatch` 指定**同一个既有 tag**，
不要删 tag 再重建。

PR / push 到 main 由 [`verify.yml`](../.github/workflows/verify.yml) 做持续校验：
`push main` / `pull_request` / `workflow_dispatch` 触发，
`pnpm install --frozen-lockfile` → `pnpm run verify`（lint + typecheck + test + build）→
`pnpm run check:packages`；它只读 `contents: read`，不接触 registry，也不需要任何凭据。

## 2. 前置条件

- **Node.js ≥ 24.9**（`engines.node`；CI 用 Node 24）。
- **pnpm `12.16.1`**（CI 固定；本地 `corepack enable` 或直接安装）。
- **npm ≥ 11.20.0**：CI 显式安装并校验 `11.20.0`（`npm install -g npm@11.20.0` +
  `npm stage --help` 能力探测）。staged publishing（`npm stage` 系列与
  `npm trust --allow-stage-publish`）自 npm 11.15.0 起提供；本仓库以 11.20.0 为
  基准。本地 npm 只在这些场合需要：第 3 节新包首发的**人工 staged publish**、
  `pnpm release:dry` / `release:stage` 预检、`npm trust` 配置、以及网页不可用时的
  例外手段 `npm stage list/view/reject/approve`。
- **npm 账号**：对 `@yankeguo` scope 有写权限、已开启 **2FA**；包已声明
  `publishConfig.access: public`。
- **包必须已存在于 npm registry**：npm 的 trusted publishing 只对已存在的包生效。
  本包尚不存在，而 npm 已拒绝占位版本，所以**必须先做第 3 节的一次性 bootstrap**
  （人工 staged publish 真实的第一个版本 `0.1.0`，并在网页 approve 让它公开）。
- **GitHub-hosted runner**（`ubuntu-latest`）：npm 不支持 self-hosted runner 的
  trusted publishing。
- **公开仓库** `yankeguo/dsh-feishu-omni`：provenance 需要公开仓库 + 公开包。
- 创建 GitHub Release 需要 **`gh` ≥ 2.0** 且已 `gh auth login`（有 repo 权限）——
  由维护者执行，或 approve 后由维护者通知的 agent 代执行。
- 解包/校验需要系统 `tar`（GNU tar 或 bsdtar；`stage-release.mjs` 用它读 tarball）。
- **不需要任何 npm secret**：仓库 secrets 中没有、也不应该有 `NPM_TOKEN`。

## 3. 新包首次发布（一次性人工 staged publish，必须先做）

> **为什么必须手工做这一步**
>
> 1. **npm 已禁止占位版本。** 按旧版本文档先发布一个占位/探针版本的做法已被 npm
>    拒绝：实际尝试时 npm CLI 直接返回 **E403**，错误原文是
>    `npm error code E403 ... You cannot publish using the version: 0.0.0-stage, just manual staged publish 0.1.0, no placeholding`。
>    也就是说，npm 现在要求新包的**第一次发布就是真实版本的人工 staged publish**，
>    不能再靠 `0.0.0-*` 占位版本让包先存在。
> 2. **trusted publisher 只能配置到已存在的包上。** `publish.yml` 用 OIDC 换 stage
>    token 时，registry 会同时校验“包存在”与“trust 记录匹配”；包不存在、又没有
>    trust 记录时，CI stage 会直接失败（E404 / ENEEDAUTH / 401），**什么都不会 stage，
>    更不会发布**。所以必须先让真实的第一个版本（本仓库即 `0.1.0`）存在于 registry：
>    由维护者**人工 staged publish** 并在网页 approve 公开，然后配置 trusted
>    publisher。
>
> bootstrap **只需做一次**。`0.1.0` 公开之后，后续所有版本（含 rc）都走第 5 节的
> 正常流程（push tag → CI stage → 网页 approve → 手动 Release），**不再需要人工
> staged publish**，也不再需要禁用 workflow。

准备工作（一次性，先完成再开始）：

- 发布准备已提交并 push 到 `main`：本文件、release notes
  [`docs/releases/v0.1.0.md`](releases/v0.1.0.md)（`pnpm check:packages` 会校验它存在且
  非空，它同时是 GitHub Release 的 `--notes-file` 正文）、README、`package.json` 的
  `0.1.0` 与发布脚本；
- `main` 与 `origin/main` 同步，工作树干净；
- 本机 `npm ≥ 11.20.0`（`npm stage publish` 自 npm 11.15.0 起提供；`npm stage
  --help` 能正常输出即具备能力），已 `npm login` 为对 `@yankeguo` scope 有写权限、
  已开启 **2FA** 的维护者账号；
- annotated tag `v0.1.0` 已在本地准备好（**尚未 push**，最后一步 g 才推）。tag 必须
  指向包含本文件与 `0.1.0` 版本号的那个 `main` commit。

### a) 在干净 main 上做发布前全量校验

```sh
# cwd: 仓库根目录（本机为 /Users/guoyk/Workspace/src/dsh-feishu-omni，可替换为你的 clone 路径）
cd /Users/guoyk/Workspace/src/dsh-feishu-omni
git checkout main
git pull
git status --short        # 必须无输出（工作树干净）

pnpm install --frozen-lockfile
pnpm verify               # lint + typecheck + test + build
pnpm check:packages       # 单包发布不变式（当前 170 项）
pnpm release:dry          # pnpm build + stage-release.mjs --dry-run：打包 + npm 预检，不上传、无 stage id
```

若 `check:packages` 报 `docs/releases/v0.1.0.md` 缺失或为空，先写好 release notes 再
继续（它同时是手动 GitHub Release 的正文）。

### b) 现构建并打出真实版本 `0.1.0` 的 tarball（不需要改 package.json）

```sh
# cwd: 仓库根目录
pnpm build        # lib/ 被 gitignore，必须现构建
rm -rf /tmp/dsh-feishu-omni-first-publish
mkdir -p /tmp/dsh-feishu-omni-first-publish
pnpm pack --pack-destination /tmp/dsh-feishu-omni-first-publish
ls -l /tmp/dsh-feishu-omni-first-publish
node -p 'require("./package.json").version'   # 0.1.0；打包前后都不改动工作树
# 期望目录里只有一个 tgz（文件名形如 yankeguo-dsh-feishu-omni-0.1.0.tgz，以实际输出为准）
```

- 首个版本就是仓库里的真实版本 `0.1.0`：**不需要**临时把 `package.json` 改成占位
  版本，也不需要事后再恢复工作树；`git status --short` 应保持无输出。
- `pnpm pack` 会触发 `prepack`（`pnpm run build`）；前面显式 `pnpm build` 只是保证
  tarball 一定来自新鲜构建产物。**不要用 `npm pack` / 在包目录直接 `npm publish`
  代替这套 pnpm 打包流程**（本仓库发布工具链以 pnpm pack 为唯一打包入口）。

### c) 在 /tmp 中性目录人工 staged publish（不要用 `npm publish` 直发）

```sh
# cwd: /tmp/dsh-feishu-omni-first-publish（中性目录：避免 npm 读到仓库里 pnpm 专用的 .npmrc 键）
cd /tmp/dsh-feishu-omni-first-publish
npm login                 # @yankeguo 维护者账号；登录时完成 2FA
npm stage publish ./*.tgz --access public --tag latest
```

- 这是**人工 staged publish**：版本只进入 npm 的 staged（待批准）列表，**还没有
  公开**；`--tag latest` 因为 `0.1.0` 就是首个 `latest`，不应使用别的 dist-tag。
- 人工 staged publish **不需要** `--allow-stage-publish`：那是给 CI 的 OIDC
  trusted publisher 授权的开关，不是人工 CLI 的参数。人工流程的 2FA 在下一步
  网页 approve 时完成（`npm stage publish` 的 2FA 被延迟到 approve 那一刻），
  因此通常也不需要在命令行传 `--otp`。
- 命令成功后 npm CLI 会打印一个 **stage id**，记下来供下一步核对；**不要**改用
  `npm publish` 直发（会绕过 staged 流程与人工 approve）。

### d) 核对 staged 记录

```sh
# cwd: 任意目录（已 npm login）
npm stage list @yankeguo/dsh-feishu-omni
npm stage view <stage-id>
```

预期：恰好一条 `0.1.0` 的 staged 记录，dist-tag 为 `latest`；此时 `npm view
@yankeguo/dsh-feishu-omni@0.1.0 version` 仍然返回 **E404**——staged 不等于已发布。

> 新包首次 staged publish 时，registry 可能先出现一个由 npm **自动创建**的临时占位包
> （“Temporary package placeholder for staged publishing”，只用于占住包名，没有
> `latest`、不能安装、也不会出现在 `npm stage list` 里）。这是 npm 的预期行为：
> **不要**手动发布或删除它，等你在 e 步 approve `0.1.0` 后它会被真实版本取代。

### e) 在 npmjs.com 网页 approve（approve 即公开、不可撤销）

1. 用维护者账号登录 <https://www.npmjs.com>（登录时完成 2FA）。
2. 打开包页面：**Packages → `@yankeguo/dsh-feishu-omni` → Staged packages**
   （pending approvals / 待批准页面）。
3. 核对版本 `0.1.0` 与 dist-tag `latest`，点 **Approve**。**approve 即公开且不可
   撤销**；approve 之后 `0.1.0` 才第一次真正公开（npm 的临时占位包会被真实版本取代）。

approve 后立即核对（任何机器都可执行，只需要读权限）：

```sh
# cwd: 任意目录
npm view @yankeguo/dsh-feishu-omni@0.1.0 version
npm view @yankeguo/dsh-feishu-omni dist-tags --json     # 应为 {"latest":"0.1.0"}
```

此步完成后 bootstrap 的核心目标（“包已存在于 registry”）达成。

### f) 配置 trusted publisher（只允许 staged publishing）

见第 4 节。**必须配置成功后才能依赖 CI 自动 stage 后续版本**；否则之后 CI 的 OIDC
交换会失败。

- **两种顺序都可行**：
  1. **先 approve 再配置（推荐）**：e 步让包存在之后运行
     `scripts/trusted-publishers.sh`，`npm trust` 不会报“包不存在”；
  2. **先配置**：如果 `npm trust` / `scripts/trusted-publishers.sh` 因为包不存在而
     失败，先完成 e 步 approve，再回来重跑本步。
- 校验：`scripts/trusted-publishers.sh --list` 应显示 `yankeguo/dsh-feishu-omni` /
  `publish.yml`，且授权动作是 staged publishing（没有旧的 `--allow-publish` 残留）。

### g) 推 tag 前临时禁用 publish workflow，然后 push tag 并创建 Release

`0.1.0` 已经公开，而 `publish.yml` 的触发条件就是 push `v*` tag：如果直接推
`v0.1.0`，CI 会尝试 **re-stage 一个已经发布过的版本**，npm 会拒绝（版本已存在），
工作流必然失败；tag 不可移动，也不能靠重跑绕过“版本已发布”这个事实。所以先禁用
该 workflow，让 tag push 不触发 CI stage，创建完 GitHub Release 后立即恢复：

```sh
# cwd: 仓库根目录（需 gh ≥ 2.0 且已 gh auth login，有 repo 权限）
gh workflow disable publish --repo yankeguo/dsh-feishu-omni
gh workflow list --all --repo yankeguo/dsh-feishu-omni    # publish 状态应为 disabled

git push origin v0.1.0                                    # tag 已在本地准备好；不要重新创建
git ls-remote --tags origin 'refs/tags/v0.1.0'            # 确认 tag 已在 origin

# 手动创建 GitHub Release：只引用既有 tag，--verify-tag 不会创建/移动 tag
gh release create v0.1.0 --repo yankeguo/dsh-feishu-omni --title v0.1.0 \
  --notes-file docs/releases/v0.1.0.md --verify-tag --latest

# 立即恢复 workflow（忘了恢复会导致后续版本推 tag 后 CI 不再 stage）
gh workflow enable publish --repo yankeguo/dsh-feishu-omni
gh workflow list --repo yankeguo/dsh-feishu-omni          # publish 应重新出现且为 active
```

- **为什么必须禁用**：`publish.yml` 由 `push: tags: v*` 触发；bootstrap 中 `0.1.0`
  已经 approve 公开，tag push 触发的那次 CI 只会尝试重新 stage 已发布版本并失败。
  这不是“可以重跑绕过”的失败：同一版本不能再次 stage/publish，而 tag 不可移动，
  所以唯一干净的做法是让这次 tag push 不触发 CI。
- **顺序不能反**：先 disable → 再 push tag → 创建 Release → 立即 enable。若忘记
  先禁用：tag push 会留下一次失败的 publish run（**不会 stage 任何东西，也不会公开
  任何东西**），不影响已公开的 `0.1.0`、tag 或 GitHub Release；不要为它删除/重建
  tag，直接继续创建 Release 并确认 workflow 处于 active 即可。
- 之后（`0.1.0` 之后的版本）`gh release create` 仍是人工步骤，但 tag push 恢复
  正常触发 CI stage，**不再需要禁用 workflow**。

### bootstrap 完成之后

- `npm view @yankeguo/dsh-feishu-omni dist-tags --json` 显示 `latest=0.1.0`，
  `npm view @yankeguo/dsh-feishu-omni@0.1.0 version` 正常；
- 第 5 节第 9 步“发布后校验：npm / tag / Release 三者一致”全部成立；
- 以后每个新版本都重复第 5 节的正常流程（bump 版本 → push tag → CI stage → 网页
  approve → 手动 Release），**不需要再做人工 staged publish**，`0.1.0` 本身也不会
  再被 stage 一次。

## 4. 一次性配置 npm 信任发布者（只允许 staged publishing）

npm 只接受来自“被信任的 CI 工作流”的 OIDC 发布请求。本包要配置**一次**，把
**本仓库 + `publish.yml` 工作流**声明为 trusted publisher，并且**只授予 staged
publishing 权限**（`--allow-stage-publish`）。

> 本包的第一次发布（第 3 节）会先**人工 staged publish 并在网页 approve `0.1.0`**，
> 让包存在于 registry；配置本节 trust 记录可以在这之前或之后执行——若 `npm trust`
> 报包不存在，先完成 approve 再重跑即可。

### 方式 A：脚本配置（推荐）

```sh
# cwd: 仓库根目录
npm login                                 # 确认是 @yankeguo 维护者
npm install -g npm@11.20.0                # 若本地 npm 不是 11.20.0
scripts/trusted-publishers.sh --dry-run   # 先看会做什么
scripts/trusted-publishers.sh             # 配置本包（包名从根 package.json 读取）
scripts/trusted-publishers.sh --list      # 校验结果
```

脚本 [scripts/trusted-publishers.sh](../scripts/trusted-publishers.sh) 相当于执行：

```sh
# cwd: 任意目录（已 npm login 的维护者机器）
npm trust github @yankeguo/dsh-feishu-omni \
  --file publish.yml \
  --repo yankeguo/dsh-feishu-omni \
  --allow-stage-publish \
  --yes
```

脚本行为说明：

- 包名从根 `package.json` 读取（单包）；`private: true` 的 manifest 会被拒绝；
- 先用 `npm trust --help` 与 `npm stage --help` 做能力探测（要求 npm ≥ 11.15）；
- **只会**传 `--allow-stage-publish`，绝不传 `--allow-publish`：直发权限对 CI 没有
  用处，stage 权限才是工作流需要的；
- `--file` 必须只是工作流文件名（`publish.yml`），不能带路径，且文件必须位于
  `.github/workflows/` 下（npm trusted publishing 的硬性要求）；
- 若使用 GitHub Environments 做发布审批，加 `--env <环境名>`，并同时在工作流 job 上
  写 `environment: <环境名>`，两边必须一致（本仓库默认**不使用** environment）；
- 每个包最多 10 个 trusted publisher；已有冲突配置时先 `npm trust list` 找到 id，再
  `npm trust revoke --id=<id>`，然后重建。

### 方式 B：npmjs.com 网页配置

包页面 → **Settings → Trusted Publisher → GitHub Actions**：

| 字段 | 值 |
| --- | --- |
| Organization or user | `yankeguo` |
| Repository | `dsh-feishu-omni` |
| Workflow filename | `publish.yml` |
| Environment name | 留空（或与工作流 `environment` 一致） |
| Allowed actions | 勾选 **npm stage publish**（不要依赖旧的 npm publish 配置） |

### 校验

```sh
# cwd: 任意目录
npm trust list @yankeguo/dsh-feishu-omni
# 或
cd /Users/guoyk/Workspace/src/dsh-feishu-omni && scripts/trusted-publishers.sh --list
```

输出应指向 `yankeguo/dsh-feishu-omni` / `publish.yml`，且授权动作为 staged
publishing（不允许旧的 `--allow-publish` 直发记录残留）。

### 从旧配置迁移（重要）

用 `--allow-publish` 创建的 trust 记录只允许 `npm publish`，**不会**授权
`npm stage publish`。如果包上已有旧配置，CI 会报 401/403 或 trust 校验错误。必须先
revoke 旧记录再重建：

```sh
# cwd: 任意目录
npm login
npm trust list @yankeguo/dsh-feishu-omni                 # 找到 GitHub Actions 记录的 id
npm trust revoke @yankeguo/dsh-feishu-omni --id=<id>     # 撤销旧的 publish-only 配置
scripts/trusted-publishers.sh                            # 用 --allow-stage-publish 重建
scripts/trusted-publishers.sh --list
```

## 5. 正常发版流程（`0.1.0` 首次发布之后）

以下以 `0.2.0` 为例（`0.1.0` 的首发走第 3 节的人工 staged publish；从 `0.1.0`
之后的版本开始走本流程，把示例里的版本号/日期替换即可）。**approve 之前 npm 上
不存在该版本；只有网页 approve 之后它才会公开。**

### 1. 准备干净的 main

```sh
# cwd: 仓库根目录
git checkout main
git pull
git status --short        # 必须无输出
```

### 2. 升级版本并同步 lockfile

单包只需改根 `package.json`：

```sh
# cwd: 仓库根目录
export VERSION=0.2.0
node -e '
  const fs = require("node:fs")
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"))
  manifest.version = process.env.VERSION
  fs.writeFileSync("package.json", JSON.stringify(manifest, null, 2) + "\n")
  console.log("bumped to", process.env.VERSION)
'
pnpm install              # 同步 lockfile（依赖规格变化时必须同步；CI 用 --frozen-lockfile 安装）
```

### 3. 写 release notes

新建或更新 `docs/releases/v<version>.md`（`0.1.0` 的 notes 可作格式参考：
[`docs/releases/v0.1.0.md`](releases/v0.1.0.md)）。它是 approve 后手动创建 GitHub
Release 时的正文（`gh release create --notes-file docs/releases/v<version>.md`）：
**文件不存在或为空时不要创建 Release**，先补齐 notes（避免 npm 已公开却没有发布说明）。
`pnpm check:packages` 会校验当前版本的 release notes 存在且非空。

### 4. 发布前检查（四条命令全绿才发）

```sh
# cwd: 仓库根目录
pnpm install --frozen-lockfile     # 锁文件一致
pnpm verify                        # lint + typecheck + test + build（lib/ 被 gitignore，必须现构建）
pnpm check:packages                # 单包不变式：manifest/engines/files/exports/locale/icon/
                                   #   平台/依赖放置/构建产物/release notes/lockfile/CI pin/staged 契约
pnpm release:dry                   # = pnpm build && node scripts/stage-release.mjs --dry-run
                                   #   本地打包 + npm 预检，不上传、不创建 stage id
```

`release:dry` 的本地预检说明：

- `scripts/stage-release.mjs` 用 `pnpm pack` 把根包打包到系统临时目录，校验 tarball
  内 `package.json` 的 name/version、不含 `workspace:`、关键文件齐全（`lib/index.js`、
  `lib/index.d.ts`、`lib/client.js`、`cordis.patch.yml`、`locale/en.json`、
  `locale/zh.json`、`icon.svg`、`LICENSE`、`README.md`、`THIRD_PARTY_NOTICES.md`、
  `docs/PUBLISHING.md`、`docs/DESIGN.md`），且 `src/`、`tests/`、`scripts/`、
  `.github/`、`node_modules/` 不泄漏进 tarball；
- 然后以临时目录为 cwd 调用
  `npm stage publish <tarball> --access public --tag <dist-tag> --dry-run --force --json`
  （dist-tag 默认：稳定版 `latest`、预发布版 `next`）；
- `--dry-run` 仍会做 registry 的“版本已存在”检查，所以预检加了 `--force` 跳过该
  检查（**真实 stage 永远不加 `--force`**）；
- 输出 `DRY RUN OK` 表示打包与 npm CLI 参数校验通过；dry-run 不验证 registry 状态、
  不上传任何内容，也不产生 stage id。

### 5. 触发 CI stage

```sh
# cwd: 仓库根目录
git add -A
git commit -m "release: v0.2.0"
git push origin main
git tag -a v0.2.0 -m "v0.2.0"          # 若 tag 尚未创建；CI 永不创建 tag
git push origin v0.2.0                 # 触发 .github/workflows/publish.yml
```

**手动 dispatch（补发 / 重跑，tag 必须已存在）**：Actions → `publish` → Run workflow，
`release_tag` 填**已存在**的 tag（例如 `v0.2.0`）；或：

```sh
# cwd: 仓库根目录
gh workflow run publish.yml --repo yankeguo/dsh-feishu-omni -f release_tag=v0.2.0
```

工作流只认既有 tag；**不要删除、重建或移动 tag**。dispatch 与 tag push 共用并发组
`publish`（`cancel-in-progress: false`），不会交错 stage。

### 6. publish.yml 的 8 个阶段与权限

工作流文件是 [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)。
按发布语义可归纳为 **8 个阶段**（对应工作流里的 13 个具名 step）：

| # | 阶段 | 具体动作 |
| --- | --- | --- |
| 1 | **Checkout** | 按 tag ref checkout（tag push 用 `github.ref`；dispatch 用 `refs/tags/<release_tag>`）；`fetch-depth: 0` 取全量历史与 tag |
| 2 | **Resolve / verify tag** | `git fetch --tags` → 确认 tag 存在 → **tag commit == HEAD** → 从 tag 推导 `RELEASE_VERSION` → 稳定版 `latest` / 预发布版 `next`。**在安装依赖之前执行**，坏 tag 数秒内失败；CI 不会创建、移动或删除 tag |
| 3 | **工具链** | pnpm `12.16.1`、Node `24`；显式 `npm install -g npm@11.20.0` 并断言版本 + `npm stage --help` 能力探测 |
| 4 | **tag-version 门禁** | 根 `package.json` 的包名必须是 `@yankeguo/dsh-feishu-omni`，`version` 必须等于 `v<version>` 中的版本；不一致直接失败 |
| 5 | **install + verify** | `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → `pnpm build`（确保 tag 对应的 commit 在 release 时仍然 typecheck/test/build 通过） |
| 6 | **check:packages** | `pnpm run check:packages`（单包发布不变式） |
| 7 | **只 stage、不发布** | `node scripts/stage-release.mjs --version "$RELEASE_VERSION" --dist-tag "$RELEASE_DIST_TAG"`；打印真实 stage id 并写入 job summary。失败即停止并打印修复提示 |
| 8 | **Release summary** | 仅在 stage 成功后写入下一步提示：到 npmjs.com 网页批量 approve，approve 后**手动**创建 GitHub Release（含 `gh release create ... --verify-tag` 命令模板） |

工作流权限（已声明）：

```yaml
permissions:
  contents: read      # GitHub Release 在 approve 后手动创建，CI 不需要写权限
  id-token: write     # OIDC：npm CLI 换取短时 token（只能 stage）
```

其他事实：运行在 **GitHub-hosted `ubuntu-latest`**；`timeout-minutes: 30`；公开仓库
+ 公开包会在 CI 生成 **provenance**；工作流**不使用** `NPM_TOKEN`/`NODE_AUTH_TOKEN`；
第三方 action 固定为 `actions/checkout@v7.0.1`、`pnpm/action-setup@v6.1.1`、
`actions/setup-node@v7.1.0`（`check-packages.mjs` 校验两个工作流的 pin 完全一致）。
job summary 会打印下一步命令；**summary 只是提示文本，CI 不会执行 `gh release`**。

### 7. 网页 approve（npmjs.com，维护者）

CI stage 成功后，版本只是 registry 里的一条 **staged** 记录：**什么都不会公开**。
批准在浏览器里完成，不需要本地 npm CLI，也不需要逐包输入 OTP：

1. 用维护者账号登录 <https://www.npmjs.com>（账号已开 2FA，登录时完成 2FA）。
2. 打开包页面：**Packages → `@yankeguo/dsh-feishu-omni` → Staged packages**
   （pending approvals / 待批准页面）。列表里能看到本包的 staged 版本，以及每条记录
   在 stage 时写入的 **dist-tag**。
3. 对照 CI 的 job summary 核对版本与 dist-tag：
   - **稳定版**：dist-tag 必须是 `latest`；
   - **预发布版**：dist-tag 必须是 `next`，**绝不能是 `latest`**（approve 会按 stage
     时记录的 dist-tag 公开；预发布一旦挂 `latest`，`npm install <pkg>` 就会默认解析
     到预发布版本）。发现以 `latest` stage 的预发布记录：**不要 approve**，先 reject
     再按正确 dist-tag 重新 stage。
4. 勾选目标版本，点 **Approve**。页面支持多选，可一次批量 approve 多个 staged 版本
   （本仓库单包，通常一次一个版本）。

> **stage 之后什么都不会公开；approve 即公开且不可撤销。** approve 一完成，包页面
> 立刻能看到该版本，registry 也可 `npm view` 到。错发没有“撤回 approve”的按钮，只有
> 72 小时内 `npm unpublish` 或后续 `npm deprecate`。

approve 后立即核对 npm dist-tags（任何机器上都能执行，只需要读权限）：

```sh
# cwd: 任意目录
npm view @yankeguo/dsh-feishu-omni@0.2.0 version
npm view @yankeguo/dsh-feishu-omni dist-tags --json
```

- 刚批准的是**稳定版**：`latest` 必须指向这个新稳定版（`0.2.0`）；
- 刚批准的是**预发布**：`latest` 必须仍然指向当前稳定版，刚批准的 rc 只应出现在
  `next`。

若 `latest` 不符合预期，按第 6 节的规则用
`npm dist-tag add @yankeguo/dsh-feishu-omni@<稳定版> latest` 纠正后，再进入下一步。

#### staged 记录的 reject（例外手段）

npmjs.com 的 staged 页面是否提供 reject 入口取决于当前网页版本。若网页**没有**
reject 入口，用本地 npm CLI 作为**例外手段**（需要 npm ≥ 11.15.0（本仓库基准 11.20.0）与 `npm login`）：

```sh
# cwd: 任意目录
npm login
npm stage list @yankeguo/dsh-feishu-omni --json   # 找到本次运行的 staged id
npm stage view <stage-id> --json                  # 核对 version/createdAt/shasum
npm stage reject <stage-id>                       # 不可恢复：删除该 staged tarball
```

reject 只影响 **staged** 记录，不会影响任何已公开版本；**approve 之后的版本无法通过
reject 撤回**。

### 8. 手动创建 GitHub Release（approve 之后）

**触发方式**：approve 完成后，由维护者通知 agent（或维护者自己）执行
`gh release create`；npm 与 CI 都**不会**自动创建 GitHub Release。tag 已经存在，本步骤
不移动、不重建、不删除 tag。

```sh
# cwd: 仓库根目录（tag 与 release notes 均已就绪）
# 稳定版
gh release create v0.2.0 --repo yankeguo/dsh-feishu-omni --title v0.2.0 \
  --notes-file docs/releases/v0.2.0.md --verify-tag --latest

# 预发布版（若适用）
gh release create v0.2.0-rc.1 --repo yankeguo/dsh-feishu-omni --title v0.2.0-rc.1 \
  --notes-file docs/releases/v0.2.0-rc.1.md --verify-tag --prerelease --latest=false
```

- `--verify-tag`：**只对已存在的 tag** 创建 Release；tag 不存在时命令直接失败，
  绝不会顺手创建 tag 或把 tag 移到别的 commit。
- `--notes-file`：Release 正文来自 `docs/releases/v<version>.md`，必须先写好且非空。
- 稳定版用 `--latest`；预发布用 `--prerelease --latest=false`，不会成为 Latest。
- 同一 tag 已有 Release 时 `gh release create` 会失败；要更新正文/标记，改用
  `gh release edit v0.2.0 --repo yankeguo/dsh-feishu-omni --verify-tag \
  --notes-file docs/releases/v0.2.0.md --latest`（预发布加 `--prerelease --latest=false`），
  仍然不会移动 tag。

### 9. 发布后校验：npm / tag / Release 三者一致

```sh
# cwd: 仓库根目录
# npm：版本已公开，dist-tag 正确
npm view @yankeguo/dsh-feishu-omni@0.2.0 version
npm view @yankeguo/dsh-feishu-omni dist-tags --json

# git：tag 指向预期的 commit（不要移动/重建）
git rev-parse 'v0.2.0^{commit}'
git ls-remote --tags origin 'refs/tags/v0.2.0'

# GitHub Release：存在、指向同一 tag，正文与标记正确
gh release view v0.2.0 --repo yankeguo/dsh-feishu-omni
```

三者必须一致：**同一个 semver、同一个 commit**——npm 上的版本由 CI 从该 tag 的
commit 构建并 stage，`gh release create --verify-tag` 只引用同一个既有 tag。
npmjs.com 上应显示 **provenance / attestation**（公开仓库 + GitHub-hosted runner
自动生成）。

在 DSH 中安装验证（前提：DSH `>=0.2.2-rc.5 <0.3.0`，Node ≥ 24.9；飞书应用配置见
[README](../README.md)）：

```sh
# cwd: 任意目录（已安装 DSH 的机器）
dsh plugin --profile desktop add @yankeguo/dsh-feishu-omni@0.2.0
```

刷新 Web 页面，打开 **Plugins**：应能看到本插件（展示标题见第 13 节），进入配置页
填 App ID / App Secret、选择 Session、点击连接；参考 [README](../README.md) 完成飞书
开放平台侧配置。

## 6. 版本与 dist-tag 策略

- **稳定版**（`x.y.z`）：默认 `latest`。CI 从 tag 推导版本并以 `--dist-tag latest`
  stage；网页 approve 后成为 `latest` 对应的已发布版本。
- **预发布**（`x.y.z-rc.N`、`-alpha.N` 等）：**打 prerelease tag 并推送即可**——CI
  自动以 `next` dist-tag stage，其余流程与稳定版完全一致（npmjs.com 网页 approve +
  approve 后手动创建 GitHub Release 并标记 prerelease）：

  ```sh
  # cwd: 仓库根目录
  git tag -a v0.2.0-rc.1 -m "v0.2.0-rc.1"
  git push origin v0.2.0-rc.1     # CI 以 next stage
  # 1) 在 npmjs.com 的 staged packages 页面 approve（确认 dist-tag 是 next）
  # 2) approve 完成后手动建 prerelease 的 GitHub Release：
  gh release create v0.2.0-rc.1 --repo yankeguo/dsh-feishu-omni --title v0.2.0-rc.1 \
    --notes-file docs/releases/v0.2.0-rc.1.md --verify-tag --prerelease --latest=false
  ```

  本地 stage 仍可作为 fallback（`node scripts/stage-release.mjs --version 0.2.0-rc.1
  --dist-tag next`，无 provenance），例如 CI 不可用或需要紧急重试时；本地 stage 用
  `npm login` 凭据，不产生 provenance。

- **三道防误发闸门**：
  1. `scripts/stage-release.mjs` 对预发布版本**默认 `next`**（`--dist-tag` 可省略），并
     **拒绝显式 `--dist-tag latest`**——approve 会按 stage 时记录的 dist-tag 公开；
  2. **网页 approve 前核对 staged 页面的 dist-tag**：预发布记录必须显示 `next`；
     发现以 `latest` stage 时**不要 approve**，先 reject 再重新 stage；
  3. GitHub Release 按版本**手动**标记：预发布 → `--prerelease --latest=false`，
     稳定版 → `--latest`，都带 `--verify-tag`；该命令不改动 stage 时记录的 dist-tag，
     也不移动 tag。
- **`engines.dsh`** 当前是精确范围 `>=0.2.2-rc.5 <0.3.0`（对齐目标 DSH `0.2.2-rc.5`），
  `engines.node` 为 `>=24.9`。DSH 升级到 0.3 时需要更新该范围并回归；
  `check-packages.mjs` 会校验该范围不被无意改动。
- 破坏性变更遵循 **semver**。每次发版前同步 README 与
  `docs/releases/v<version>.md`，并确认根 `package.json` 的 `version` 已 bump、
  lockfile 已同步。`0.1.0` 是首个稳定版：**首次发布走第 3 节的人工 staged publish，
  在网页 approve 之前 npm 上不存在 `0.1.0`**；approve 后 `latest` 才指向它，之后
  的版本才走第 5 节的 tag → CI stage 流程。

## 7. 脚本参考

### `scripts/stage-release.mjs`（CI / 本地 stage）

打包并 stage 根包；**不发布任何内容**。

| 参数 / 环境变量 | 说明 |
| --- | --- |
| `--version <x.y.z>` | 期望版本；默认根 `package.json` 版本，必须与 manifest 一致，否则失败 |
| `--dist-tag <tag>` | npm dist-tag；默认稳定版 `latest`、预发布版 `next`；预发布版本显式传 `latest` 会被拒绝；不能写成版本号 |
| `--dry-run` | 打包 + `npm stage publish --dry-run --force` 预检，不上传、不创建 stage id |
| `--no-provenance` | 即使在 GitHub Actions 中也不传 `--provenance` |
| `GITHUB_ACTIONS=true` | 传 `--provenance`（npm 也会对公开包自动启用 provenance） |
| `GITHUB_STEP_SUMMARY` | 设置时把 staged 版本表写进 Actions job summary |

脚本会断言（失败即停止，打印真实 stage id（若有）与修复提示；**不打印假的 stage
id**）：包名/版本正确、manifest 非 private、`lib/index.js` + `lib/index.d.ts` +
`lib/client.js` 已现构建、tarball 的 manifest name/version 正确、不含 `workspace:`、
关键发布文件齐全、源码/测试/发布脚本不泄漏。临时 tarball 目录在结束时删除，不污染
仓库。

### `scripts/trusted-publishers.sh`（一次性 trust 配置）

单包版：包名从根 `package.json` 读取；支持 `--dry-run` / `--list` / `--repo` /
`--file` / `--env`；只授予 `--allow-stage-publish`，绝不 `--allow-publish`。先做
`npm trust --help` / `npm stage --help` 能力探测（npm ≥ 11.15）。

### `scripts/check-packages.mjs`（单包不变式校验）

只读、无第三方依赖，CI 在 build 之后运行。当前共 **170 项**检查，覆盖：

- manifest 身份与发布形态（name/semver/非 private/`publishConfig.access=public`/
  repository/homepage/bugs/type/description/license）；
- `engines.dsh` 精确范围 `>=0.2.2-rc.5 <0.3.0`、`engines.node`；
- `files` / `exports` 接线（含 `"./client": "./lib/client.js"`、`docs`、
  `THIRD_PARTY_NOTICES.md`、`./locale/*.json`、`./icon`、`./package.json`）；
- DSH bundle 契约（`dsh.bundle.patch` → 存在的 `cordis.patch.yml`、
  `dsh.client.platform=web` 与四项 inject、icon ≤ 256 KiB、`locale/en.json` +
  `locale/zh.json` 的 `meta.title`/`meta.description` 非空且无营销最高级）；
- DSH 依赖放置（host 包必须是 peer、peer 必须装为 devDependency、peer 是范围而不是
  精确 rc pin）、运行依赖固定（`@larksuiteoapi/node-sdk@1.76.0`、`axios@1.16.0`）；
- 构建产物（`lib/index.js`、`lib/index.d.ts`、`lib/client.js` 的
  `__ModuleLoader__` 包装与 loader id）；
- 当前版本的 release notes（`docs/releases/v<version>.md` 存在且非空）；
- 根 `package.json` scripts 接线（含 `check:packages`、`release:dry`、
  `release:stage`、`prepack`，且没有 `release:promote` / `release:publish`）；
- `pnpm-lock.yaml`（仅根 importer、依赖规格与 package.json 双向一致）；
- 两个 workflow 的 action pin / pnpm / node / npm 版本、权限、staged 契约与
  `--verify-tag` 发布说明提示；
- `trusted-publishers.sh` 只授予 `--allow-stage-publish`；
- README 指向本文档、且不含已删除的 promote 脚本。

输出逐项 PASS/FAIL 清单，任一失败以非零码退出；成功时打印
`check-packages: OK (170 checks, single package @yankeguo/dsh-feishu-omni)`。

### 根 `package.json` scripts

| script | 等价命令 | 用途 |
| --- | --- | --- |
| `pnpm build` | `tsc -p tsconfig.build.json && node scripts/build-client.mjs && node scripts/check-package.mjs` | 构建 Host 与 Web Client，并校验入口 |
| `pnpm typecheck` | `tsc -p tsconfig.json --noEmit` | 类型检查 |
| `pnpm lint` | `eslint src tests scripts eslint.config.js vitest.config.ts` | lint |
| `pnpm test` | `vitest run` | 单元测试（fake 飞书网关/Session/临时目录） |
| `pnpm verify` | `pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build` | 本地/CI 的一次性校验 |
| `pnpm check:packages` | `node scripts/check-packages.mjs` | 单包发布不变式 |
| `pnpm release:dry` | `pnpm build && node scripts/stage-release.mjs --dry-run` | 本地打包 + npm 预检（不上传） |
| `pnpm release:stage` | `pnpm build && node scripts/stage-release.mjs` | 本地 stage（需 `npm login`；CI 不用它） |
| `pnpm prepack` | `pnpm run build` | `pnpm pack` / `stage-release.mjs` 前保证 lib/ 新鲜 |

不存在本地 approve / Release 脚本，也**不存在 promote / 直发脚本**：审批在
npmjs.com 网页完成，GitHub Release 在 approve 后手动用 `gh release create
--verify-tag` 创建。

## 8. 故障恢复

### CI stage 失败

1. `stage-release.mjs` 会在失败处停止并打印修复提示；若 npm 已返回 stage id，job
   summary 也会保留一张表；此时**没有任何版本公开**。
2. 修复失败原因（常见：trusted publisher 仍是旧的 `--allow-publish` 配置、新包首发
   bootstrap 未完成（包不存在 / 无 trust 记录，先做第 3 节）、npm 版本不对、网络、
   版本已发布）。
3. **推荐恢复方式**：先把这次失败留下的 staged 记录 reject，再从干净状态重跑 CI：

   ```sh
   # cwd: 任意目录
   npm login
   npm stage list @yankeguo/dsh-feishu-omni --json   # 找出本次失败运行的 staged id
   npm stage reject <stage-id>                       # 不可恢复，谨慎
   ```

   然后 Actions → `publish` → Run workflow → `release_tag` 填**同一个既有 tag**（或
   `gh workflow run publish.yml --repo yankeguo/dsh-feishu-omni -f release_tag=v0.1.0`）。
   CI 会重新 stage，provenance 也重新生成。前提是该版本**尚未发布**；已经发布的版本
   不能通过 dispatch 重新 stage，只能升版本。

4. 如果上一次运行其实**已经 stage 成功**，不要重跑 stage：直接到 npmjs.com 的
   staged packages 页面 approve 该版本。
5. **不要删除或重建 tag**：重跑用 `workflow_dispatch` + 同一个既有 tag；CI 与
   `gh release create --verify-tag` 都不会创建/移动 tag。

> 为什么不能“只补 stage 一次”？重复 stage 同一版本的结果没有保证（可能被 registry
> 拒绝，也可能留下多条同版本 staged 记录）。因此“先 reject 本次残留记录、再用同一
> 既有 tag 全量重跑”是最干净、可预测的恢复路径。

### approve / GitHub Release 失败

- 一旦 approve，版本**立即公开**，无法撤销。approve 是在网页上完成的一次性动作；
  需要重试的通常只有后面的 GitHub Release 创建。
- 如果 GitHub Release 创建失败：包已公开，只需修好 `gh auth`/网络后重跑同一条
  `gh release create ... --verify-tag` 命令；若 Release 已存在但正文/标记不对，用
  `gh release edit <tag> --verify-tag --notes-file docs/releases/v<version>.md`
  （预发布加 `--prerelease --latest=false`）修正，不会移动 tag。
- 网页 approve 前发现预发布记录的 dist-tag 是 `latest`：**不要 approve**。先 reject
  该 staged 记录（网页无入口时用例外手段 `npm stage reject <stage-id>`），再按正确
  dist-tag 重新 stage。
- approve 后核对发现 `dist-tags.latest` 指向了预发布：包**已经公开**；立即
  `npm dist-tag add @yankeguo/dsh-feishu-omni@<稳定版> latest` 把 latest 指回稳定版，
  然后照常手动创建 GitHub Release。
- 网页操作失败/不可用：版本仍是 staged、**没有公开**；先重试网页。若网页持续不可用，
  可用本地例外手段 `npm stage approve <stage-id>`（需要 npm ≥ 11.15.0（本仓库基准 11.20.0）、`npm login`
  与 2FA OTP）完成批准，然后照常手动建 Release。

### 其它典型情况

| 现象 | 处理 |
| --- | --- |
| CI 报 401/403 / `no trust evidence` / trust 校验错误 | trusted publisher 配置与本次运行不匹配，或配置是旧的 `--allow-publish`（不允许 stage）。核对 repo、**工作流文件名**、environment；必要时 `npm trust list` → `npm trust revoke --id=<id>` → `scripts/trusted-publishers.sh` 重建 |
| CI 报 `ENEEDAUTH`（stage 阶段） | 工作流缺少 `id-token: write`，或本包还没有匹配的 trusted publisher（新包首发 bootstrap 未完成）。先完成第 3 节（人工 staged publish 首发 + 配置 trust） |
| CI 报 `npm stage` 不存在 | runner 上的 npm < 11.15；工作流已显式安装并校验 11.20.0，检查 npm 安装步骤日志 |
| `npm stage list` / `npm trust list` 报 401/ENEEDAUTH | 本地未 `npm login`，或登录凭据不可用于该操作；approve/reject 还需要交互式 2FA |
| `npm view` 报 **E404**（两种含义） | ① `npm view @yankeguo/dsh-feishu-omni version` 404 = **包不存在**，先做第 3 节 bootstrap（人工 staged publish 真实的第一个版本并网页 approve）；② `npm view @yankeguo/dsh-feishu-omni@<version> version` 404 = **该版本还不存在**，说明尚未 approve，或 CI 尚未 stage 成功 |
| 同一版本出现多条 staged 记录 | `npm stage view <id> --json` 比较 createdAt/shasum，保留一条、`npm stage reject` 其余；每次运行只应有一条 |
| staged 了错误 commit 的版本 | reject 该版本的全部 staged id，确认 tag/commit 后再 dispatch **同一个既有 tag**（不会移动 tag） |
| 版本已经发布 | 不能再次 stage/publish 同版本；升版本重新发版（72 小时内可 `npm unpublish`，见下） |
| 想用 workflow_dispatch 重跑 | `release_tag` 必须是已存在且**尚未发布**的 tag；工作流校验 tag commit == HEAD。已发布版本不能重新 stage。**不要删除/重建/移动 tag** |
| tag 不存在 | 先把既有 tag `git push origin <tag>`；CI 与 `gh release create --verify-tag` 都不会创建 tag |
| 想创建 Release 时 notes 文件不存在/为空 | 先写 `docs/releases/v<version>.md`，再用 `--notes-file` 指定；正文缺失时不要创建 Release |
| 首发时 npm 报 **E403**（`You cannot publish using the version: ... , just manual staged publish 0.1.0, no placeholding`） | npm 已禁止占位版本：新包第一次发布必须由维护者人工 staged publish 真实版本（第 3 节 c），不要再使用占位/探针版本 |
| `npm trust` / `scripts/trusted-publishers.sh` 报包不存在 | trusted publisher 只能配置到已存在的包；先完成第 3 节 e（人工 staged publish + 网页 approve）让 `0.1.0` 公开，再重跑 trust 配置 |
| bootstrap 推 tag 后 publish workflow 失败（版本已发布） | 推 tag 前没有禁用 workflow：已公开版本不能再次 stage，这次失败不影响发布内容；按第 3 节 g 继续创建 Release，并确认 workflow 已恢复 active |
| 误发版本 | npm 允许 72 小时内 `npm unpublish @yankeguo/dsh-feishu-omni@<version>`；超过则只能 `npm deprecate` 并升版本 |
| provenance 未生成 | 仓库非公开、runner 非 GitHub-hosted、或本地 stage（本地不生成）；公开仓库 + hosted runner 会在 CI 中生成 |

## 9. 首次发布与首次 CI 运行验证清单

### A. 首次发布（第 3 节人工 staged publish `0.1.0`，一次性）

- [ ] 本地 `main` 干净、根 `package.json` 版本为 `0.1.0`、lockfile 已同步、
      `docs/releases/v0.1.0.md` 存在且非空
- [ ] `pnpm verify`、`pnpm check:packages`、`pnpm release:dry` 全绿
- [ ] `pnpm build` 后 `pnpm pack --pack-destination /tmp/...` 的 tarball 版本为
      `0.1.0`（没有临时改过 `package.json`）
- [ ] 人工 staged publish 成功：`npm stage publish ./*.tgz --access public --tag
      latest` 打印了 stage id
- [ ] `npm stage list @yankeguo/dsh-feishu-omni` 恰好一条 `0.1.0` 记录，dist-tag 为
      `latest`
- [ ] 网页 approve 前 `npm view @yankeguo/dsh-feishu-omni@0.1.0 version` **仍应 404**
      （registry 上可能只有 npm 自动创建的临时占位包；它没有 `latest`、不能安装，属正常）
- [ ] npmjs.com 网页 approve 后：`npm view @yankeguo/dsh-feishu-omni@0.1.0 version`
      正常，`npm view @yankeguo/dsh-feishu-omni dist-tags --json` 的 `latest` 指向
      `0.1.0`
- [ ] trusted publisher 已配置：`scripts/trusted-publishers.sh --list` 显示
      `publish.yml` / `yankeguo/dsh-feishu-omni`，且授权动作为 staged publishing
      （没有旧的 `--allow-publish` 残留）
- [ ] 推 tag 前已执行 `gh workflow disable publish --repo yankeguo/dsh-feishu-omni`
      （`gh workflow list --all` 显示 disabled），push `v0.1.0` 后没有触发新的
      publish run
- [ ] 手动执行 `gh release create v0.1.0 --repo yankeguo/dsh-feishu-omni --title v0.1.0
      --notes-file docs/releases/v0.1.0.md --verify-tag --latest`（stable）
- [ ] `gh release view v0.1.0 --repo yankeguo/dsh-feishu-omni` 与 tag/commit 一致
- [ ] 已执行 `gh workflow enable publish --repo yankeguo/dsh-feishu-omni`，且
      `gh workflow list` 能重新看到 `publish`（active）

### B. 首次 CI 运行（`0.1.0` 之后的下一个版本，示例 `0.2.0`）

- [ ] 本地 `main` 干净、根 `package.json` 版本为 `0.2.0`、lockfile 已同步、
      `docs/releases/v0.2.0.md` 存在且非空
- [ ] `pnpm verify`、`pnpm check:packages`、`pnpm release:dry` 全绿
- [ ] `v0.2.0` tag 已 push 且指向 `main` 上正确的 commit
- [ ] publish.yml 的 “Resolve and verify the release tag” 与 tag-version 校验通过
      （tag commit == HEAD 且 `v0.2.0` ↔ `package.json` `0.2.0`）
- [ ] CI 日志出现 “npm 11.20.0 supports staged publishing”
- [ ] “Stage the package on npm (publishes nothing)” 打印**恰好 1 个** stage id，
      且 job summary 有 staged 表；此时**什么都还没公开**
- [ ] approve 前 `npm view @yankeguo/dsh-feishu-omni@0.2.0 version` **仍应 404**
      （registry 上只有已发布的旧版本）
- [ ] `npm stage list @yankeguo/dsh-feishu-omni --json` **恰好一条** `0.2.0` 记录
- [ ] npmjs.com 的 staged packages / pending approvals 页面能看到 `0.2.0`，dist-tag 为
      `latest`
- [ ] 网页 approve 后：`npm view @yankeguo/dsh-feishu-omni@0.2.0 version` 正常，
      `npm view @yankeguo/dsh-feishu-omni dist-tags --json` 的 `latest` 指向 `0.2.0`，
      npmjs.com 显示 provenance
- [ ] 手动执行 `gh release create v0.2.0 --repo yankeguo/dsh-feishu-omni --title v0.2.0
      --notes-file docs/releases/v0.2.0.md --verify-tag --latest`（stable），
      `gh release view v0.2.0 --repo yankeguo/dsh-feishu-omni` 与 tag/commit 一致
- [ ] npm version、git tag commit、GitHub Release 三者一致
- [ ] 仓库 secrets 中**没有** `NPM_TOKEN`（本包不需要任何 npm secret）

## 10. 安全说明与 provenance

1. 工作流声明 `permissions: id-token: write` 后，GitHub Actions 通过
   `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN` 暴露 OIDC ID
   token 获取端点（每个 job / 每次运行都是新的短时 token）。
2. npm CLI（不是 pnpm）检测到该环境后，请求受众为 `npm:registry.npmjs.org` 的 ID
   token，向 registry 的 `/-/npm/v1/oidc/token/exchange/package/<pkg>` 换取**一次性的
   stage token**；也可通过 `NPM_ID_TOKEN` 传入。
3. npm 侧校验 OIDC claims（仓库、工作流文件名、可选 environment）与包的 trusted
   publisher 配置一致，并且配置允许 staged publishing，然后接受 stage 请求。
4. token 短时且绑定具体工作流；**CI 不能 list/approve/reject**。本仓库的常规 approve
   由维护者在 npmjs.com 网页完成（登录 + 2FA）；本地 CLI 的 approve/reject 只作为
   网页不可用/网页无 reject 入口时的例外手段（仍需 `npm login` + 交互式 2FA）。
5. provenance 由 npm CLI 在 OIDC token 交换成功后生成（Sigstore）：需要公开仓库 +
   公开包；CI 中 `stage-release.mjs` 显式传 `--provenance`，npm 也会对公开包自动启用。
   本地 stage（`npm login` 凭据）不产生 provenance；如不需要可加 `--no-provenance`。
6. stage 记录与 provenance 均可在 npmjs.com / registry 审计；GitHub Release 用
   `gh release create ... --verify-tag` 手动创建，tag 固定指向 CI 构建的 commit，
   创建 Release 不会移动 tag。

> pnpm 版本要求：本仓库 CI 固定 `pnpm@12.16.1`，但 staged publishing / OIDC /
> provenance 全部由 **npm CLI** 完成；CI 因此显式安装并固定 `npm@11.20.0`。

## 11. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `npm view @yankeguo/dsh-feishu-omni` 一直 404 | 包尚未发布。先做第 3 节 bootstrap（人工 staged publish，网页 approve 后包才存在）；人工 staged publish 之后、approve 之前也仍是 404，属正常 |
| CI stage 报 401/403 / trust 校验错误 | trust 配置不匹配或仍是旧的 `--allow-publish`；`npm trust list` → `npm trust revoke --id` → `scripts/trusted-publishers.sh` 重建 |
| CI stage 报 `ENEEDAUTH` | `id-token: write` 缺失，或包尚未人工 staged publish 首发并 approve / 未配置 trusted publisher（bootstrap 未完成） |
| `npm stage` 命令不存在 | npm < 11.15；升级到 11.20.0（CI 已固定） |
| 网页 approve 报 2FA/登录失败 | 重新登录 npmjs.com 并完成 2FA；网页 approve 不逐包输入 OTP |
| staged packages 页面看不到本版本 | CI 未运行或 stage 失败；先跑发布工作流（tag push 或 dispatch 既有 tag），stage 成功后页面才会出现该版本 |
| 同一版本出现多条 staged 记录 | 保留一条、reject 其余；每次运行只应有一条 |
| staged 页面显示预发布记录的 dist-tag 是 `latest` | **不要 approve**；先 reject 再按 `next` 重新 stage（或 dispatch 同一 tag 重跑，CI 自动用 next） |
| approve 后 `dist-tags.latest` 指向预发布 | 包已公开；`npm dist-tag add @yankeguo/dsh-feishu-omni@<稳定版> latest` 纠正，再手动建 Release |
| 首发时 npm 报 **E403** `no placeholding` | npm 已禁止占位版本；按第 3 节人工 staged publish 真实版本，不要再尝试占位/探针版本 |
| bootstrap 推送 tag 时 publish workflow 失败 | 推 tag 前需临时禁用 workflow（第 3 节 g）；已公开版本不能再次 stage，失败 run 不影响已发布内容，继续创建 Release 并恢复 workflow |
| 想撤回已经公开的版本（approve 之后） | approve 不可撤销；72 小时内可 `npm unpublish`，之后只能 `npm deprecate` 并升版本 |
| `gh release create --verify-tag` 报 tag 不存在 | 先把既有 tag push 到 origin；CI 与 `--verify-tag` 都不会创建 tag |
| 想改用新工作流文件名/环境 | 先 `npm trust list` + `npm trust revoke --id`，再用 `scripts/trusted-publishers.sh` 重建（每包最多 10 个 trusted publisher） |

## 12. 发布后的用户安装方式

**approve 之后**（即 npm 上真正存在 `0.1.0` 之后）：

```sh
# cwd: 任意目录（已安装 DSH 的机器）
# 精确版本（推荐；与 Release 对齐）
dsh plugin --profile desktop add @yankeguo/dsh-feishu-omni@0.1.0

# 省略版本（approve 后 latest 指向 0.1.0）
dsh plugin --profile desktop add @yankeguo/dsh-feishu-omni
```

也可以在 Web：**Plugins → Add plugin**，输入 `@yankeguo/dsh-feishu-omni`。

**第 3 节 bootstrap 完成（`0.1.0` 网页 approve）之前**都不能从 npm 安装：bootstrap
之前 npm 上连这个包都不存在；人工 staged publish 之后、网页 approve 之前，`0.1.0`
仍不存在（staged 不等于已发布），registry 上可能只有 npm 自动创建的临时占位包
（没有 `latest`、不能安装）。之后的新版本在 approve 之前同样不存在
（`npm view @yankeguo/dsh-feishu-omni@<version>` 返回 E404）。这些情况都只能按
[README](../README.md) 的“从源码目录安装”：clone 仓库 → `pnpm install` →
`pnpm build` → 在 DSH 的 **Plugins → Add plugin** 中粘贴仓库目录的**绝对路径**
（`lib/` 被 gitignore，全新 clone 必须现构建）。

运行前提：DSH `>=0.2.2-rc.5 <0.3.0`（目标安装版 `0.2.2-rc.5`）、Node.js `>=24.9`；
飞书企业自建应用的权限、事件订阅与长连接配置见 [README](../README.md)（`App ID` /
`App Secret` 在 **Settings → 飞书 Omni** 或插件配置页填写）。DSH 升级到 0.3 时需先
更新 `engines.dsh` 并回归。

## 13. 插件展示元数据（`locale/*.json`）

DSH 插件管理器/插件市场显示的是**用户友好标题与一句话描述**，不是 npm 包名和技术性
`description`。DSH 的 `readPluginMeta` 在**不执行插件代码**的前提下读取：

1. `@yankeguo/dsh-feishu-omni/locale/en.json`（必须能通过 Node ESM `exports` 解析）；
2. 同目录其它 `<语言>.json` 作为翻译（语言 ID 取文件名小写，例如 `zh.json`）；
3. 字段缺失时回落到 `package.json` 的 `name` / `description`；manifest `icon` 字段
   提供图标（相对路径、位于包目录内、≤ 256 KiB、SVG/PNG/JPEG/WebP）。

本包当前展示标题：**Feishu shared Session**（中文：**飞书共享 Session**），描述分别见
`locale/en.json` 与 `locale/zh.json` 的 `meta.description`。接线方式（已由
`pnpm check:packages` 强制）：

```json
{
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg",
    "README.md",
    "docs",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md"
  ]
}
```

约束：`locale/en.json` + `locale/zh.json` 同时具备；`meta.title`、
`meta.description` 均为非空字符串，中英文语义一致；描述是一句准确的功能说明，
**不使用营销词 / 最高级**（check-packages 内置禁用词表）；`icon.svg` 当前 472 字节
（≤ 256 KiB）。发布后验证展示效果：安装插件 → 刷新 Web 页面 → **Plugins / 插件**：
应显示 **Feishu shared Session**（中文界面为 **飞书共享 Session**）与一句话描述、icon。

## 14. 参考

外部文档：

- npm staged publishing：[npm stage](https://docs.npmjs.com/cli/v11/commands/npm-stage)、
  `npm help stage`
- npm trusted publishing：[Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/)
- `npm trust` 命令：`npm help trust` / [npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust)
- pnpm：[pnpm pack](https://pnpm.io/cli/pack)
- OpenSSF [Trusted Publishers](https://repos.openssf.org/trusted-publishers) 标准
- GitHub CLI：[gh release create](https://cli.github.com/manual/gh_release_create)

本仓库内相关文件：

- [`../.github/workflows/publish.yml`](../.github/workflows/publish.yml) —— CI stage（只
  stage，不发布）
- [`../.github/workflows/verify.yml`](../.github/workflows/verify.yml) —— push main / PR
  的持续校验
- [`../scripts/stage-release.mjs`](../scripts/stage-release.mjs) —— 打包 + `npm stage
  publish`
- [`../scripts/check-packages.mjs`](../scripts/check-packages.mjs) —— 单包发布不变式
- [`../scripts/trusted-publishers.sh`](../scripts/trusted-publishers.sh) —— 一次性
  trusted publisher 配置
- [`../README.md`](../README.md) —— 安装、飞书应用配置与使用说明
- [`releases/v0.1.0.md`](releases/v0.1.0.md) —— `0.1.0` 的发布说明（手动 GitHub Release
  的正文）
