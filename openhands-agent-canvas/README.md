# OpenHands 智能体画布

中文、适配手机、密码保护的多智能体工作台。画布配置保存在服务器，真实任务由后台队列按依赖顺序执行，关闭页面后继续运行。可通过网页、Codex MCP 插件和 `canvas` 命令行操作同一套项目。

主要入口：https://canvas.43-173-109-57.sslip.io

该入口直接部署在硅谷服务器，已从上海验证可访问。Sites 镜像仍保留：https://openhands-agent-canvas-q7m2.awakesugar5.chatgpt.site（部分地区访问可能返回 403）。

5.7 引擎支持整包文件交接、存储与执行重叠、事件完成唤醒，以及限制内存的多分支合并。三服务器已开启整包交接与事件流；DeepSeek 继续固定 V4.1 Flash + max，最强可用模型继续负责自主分工。[性能记录](docs/performance-5.7.0.json) 分开记录真实文件传输、内存能力及固定模型响应的完整链路夹具；这些结果不能替代真实 AI 项目整体四倍提速的证明。

5.8 中，强规划 AI 可直接实现并交付简单需求，省去第二次实现调用；也可按每个分工的难度分别选择已验证模型和思考深度。实际成果文件、模型回执和数据桶保存要求保持生效，用户手动设置优先。配套插件版本 2.7。

5.9 / 插件 2.8 优先支持 GitHub 闭环：独立开发分支、多文件原子提交、CI、PR，检查通过后由 Codex 批准当前 SHA 再合并。首个真实流程已完成 [PR #1](https://github.com/napoleonhalvorson1-design/dsh-gpt/pull/1)。聊天优先使用已连接 GitHub；后台自动操作需要独立凭据，状态会明确区分。合并不放入预先执行的自动流程，空 CI 或过时批准不能通过。

5.10 / 插件 2.9 支持自托管任务自动导入仓库：项目填写 `repository: "owner/repo"`、`branch`，可选 `githubConnectionId`。引擎固定源提交、一次下载并保存到桶后再执行，所有分支共享源代码，重试和恢复保留原 SHA。脚本执行位经归档和整包交接保留。公开仓库可匿名读取；私有仓库需要所选后台 GitHub 连接的读取权限。

## 使用

1. 打开主要入口，输入工作台密码登录。默认使用硅谷 Codex。项目可选择上海 Codex / DeepSeek、硅谷 Codex / Claude、首尔 Codex，每个节点也可以单独选择。
2. 点击「新建项目」选择单个 AI、同一 AI 的规划→开发→审查流程，DeepSeek→Codex→Claude 三 AI 协作流程，或五 AI 融合流程，已自动连线。填写页面上的任务后点击「开始任务」。每次运行有独立工作目录，后续节点接收上游输出。
3. 「我的项目」可切换项目；「查看结果与文件」可阅读输出、查看文件内容、预览静态 HTML、下载完整产物；运行记录保留重试入口。手机支持同样的功能。
4. 设置中的「服务器与 AI 连接」可切换其他 Agent Server、模型 API 或 OpenHands Cloud。连接测试不创建任务。

本地模拟有独立标识，不调用真实模型。ACP 模式使用 CLI 自己的工具；画布工具配置对普通 OpenHands API 模式生效。云端启动仍需对应平台可用的沙箱与额度，三个服务器的五个执行入口统一由工作台调度，每个阶段保留原有账号和模型设置。

## 对象存储

设置 → S3 对象存储。支持 Endpoint、桶名、Region、独立前缀、Access Key / Secret Key 和 Path Style，凭据加密保存在服务器。桶保持私有。

| 服务 | Endpoint | Region | Path Style |
| --- | --- | --- | --- |
| R2 | `https://<account>.r2.cloudflarestorage.com` | `auto` | 关闭 |
| AWS S3 | 可留空，SDK 使用区域地址 | 桶所在区域 | 关闭 |
| MinIO | 你的 HTTPS S3 地址 | 常用 `us-east-1` | 开启 |

配置后点「保存并验证读写」，会在独立测试前缀写入、读取并删除一个临时对象。通过后开启自动同步：

- `projects/<projectId>/latest.json` 与 `versions/<revision>.json`：当前项目和版本。
- `runs/<runId>/artifacts.tar.gz` 与 `manifest.json`：已完成运行的文件归档与清单。
- `backups/<timestamp-id>.sqlite`：每天自动生成的一致性 SQLite 备份，也可手动备份并下载。

每 15 秒检查同步变更。上传失败保留本机数据库和产物，下次重试。默认不删除远端历史，桶的生命周期和容量按实际需求配置。密钥不要写入工作流、仓库或聊天。当前没有配置用户的真实桶，协议读写已经通过隔离 S3 服务验证。

恢复：先下载备份到独立目录。使用 `/etc/openhands-control/runtime.env` 中原来的 `CANVAS_CONTROL_ENCRYPTION_KEY` 打开备份，核对项目、运行和加密配置；主密钥必须另行保管，不随数据库上传。确认后停止控制服务，保留原数据库与 WAL/SHM 的完整副本，再替换数据库，属主设为 `openhands-control`、权限 600，启动服务。不要将备份覆盖到运行中的数据库。产物还原从对应 runs/ 前缀下载；恢复旧运行可能重新连接或继续模型任务，实际恢复前先检查状态。

## 通过 Codex 操作

上海、首尔、硅谷三台服务器均已安装并配置 `canvas`，可以直接运行 `canvas projects list`。其他机器可在设置→通过 Codex 操作中下载命令行文件，执行 `node canvas.mjs login`；也可从源码运行 `node bin/canvas.mjs`。

在设置 → 通过 Codex 操作中创建可撤销令牌，按读取、编辑项目、运行任务授权。然后执行交互登录，令牌输入隐藏并保存在权限 600 的本机配置文件：

```sh
canvas login
canvas projects list
canvas profiles list
canvas projects get --id PROJECT_ID
canvas projects put --id PROJECT_ID --file workflow.json --revision 1
canvas runs start --project PROJECT_ID --id UNIQUE_REQUEST_ID --profile codex-silicon
canvas runs wait --id RUN_ID
canvas runs events --id RUN_ID --after 0
canvas runs files --id RUN_ID
canvas runs file --id RUN_ID --path index.html
canvas runs artifacts --id RUN_ID --output result.tar.gz
canvas runs stop --id RUN_ID
canvas runs resume --id RUN_ID
```

也支持 `OPENHANDS_CANVAS_URL`、`OPENHANDS_CANVAS_TOKEN` 环境变量与 JSON 标准输入。所有输出为 JSON，错误退出码为 1，任务失败/暂停的 wait 退出码为 2。下载不会覆盖已有文件。

MCP：安装此网站发布时生成的同名私有插件。在网页设置生成 10 分钟有效的一次性连接码，让 Codex 调用 `canvas_connect` 绑定当前账户。随后使用 `canvas_list_projects`、`canvas_save_project`、`canvas_start_run`、`canvas_run_status`、`canvas_run_events`、`canvas_stop_run` 等工具。公开网站访问权限不会自动授予执行权限，必须完成密码页面内的账户绑定。

API 使用网站 `/api/projects`、`/api/runs` 等相同接口，`Authorization: Bearer <service-token>`。令牌不能管理凭据或签发其他令牌。项目更新使用 expectedRevision 检查冲突，运行提交的 id 用于幂等重试。详细操作规则见 [AGENTS.md](AGENTS.md)。

## 部署与数据

- `openhands-web.service`：独立 HTTPS 主入口，复用同一份 Worker 构建和数据库；只监听本机 18120。环境文件 `/etc/openhands-control/web.env` 由 root 保管，使用独立的 `openhands-web` 用户运行。页面无需请求 OpenAI 或 Google 域名。直连入口拒绝 MCP 身份头，MCP 仅通过 Sites 插件接入。
- Sites Worker：镜像页面、API 代理和 MCP。密钥只在服务端，浏览器 localStorage 仅保存工作流缓存。
- 硅谷：`openhands-control.service` 保存 SQLite、运行日志、产物缓存和加密配置，目录 `/srv/openhands/control`；只监听本机 18110，通过 HTTPS `/control/` 访问并校验独立服务密钥。
- 硅谷 AI 执行：`openhands-silicon.service` / Agent Server 1.58.1，监听本机 18182，复用 ubuntu 的 Codex 与 Claude 登录；Codex ACP 固定 2.2.2，Claude ACP 固定 0.23.1。空闲会话 45 秒后释放运行时，记录保留在磁盘。
- 上海：官方 `openhands-agent-server.service` / Agent Server 1.58.1，只监听本机 18181，复用已有 Codex 登录与网络配置。DeepSeek Harness 使用既有 `dsh --profile acp`；旧 Codex 通道保留供历史运行恢复。
- 硅谷通过受限 SSH 隧道连接上海，nginx 提供 HTTPS 与自动续期证书。另有官方 Agent Canvas 1.33.0 / Agent Server 1.58.1 固定摘要容器，仅绑定本机 18081。
- 首尔资源紧张，未新增服务。已有其他项目服务保持原状。

Sites 配置见 `.env.example`。服务器系统服务模板见 `ops/openhands-control.service`。更改网站密码时同时轮换会话签名密钥并重新部署，注销旧会话。保管数据库加密主密钥，丢失后无法解密运行与 S3 凭据。

## 开发和验证

Node.js >=22.16：

```sh
npm ci
npm run build
npm test
npm run dev
```

本机预览默认 `http://localhost:4173`，开发密码 `local-preview-only`。测试覆盖鉴权、CSRF、后端隔离、ACP、事件分页、后台持久化、重启恢复、停止确认、失败重试、令牌权限、MCP 绑定与 S3 凭据加密。

生产环境已完成真实三节点规划 → 写文件 → 审查验收，并下载、打开产物验证中文待办的添加、完成、删除、刷新保存与手机布局。S3 SDK 的签名请求、版本快照、一致性数据库备份已使用隔离 S3 服务验证；用户自己的桶仍需填写配置后验证。

官方参考：[OpenHands](https://docs.openhands.dev/openhands/usage/agent-canvas/setup)、[ACP](https://agentclientprotocol.com/)、[R2 S3 SDK](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)。

## 3.1 可用性修复

修复后台连接超过 8 秒时初始化丢失的问题；请求结果丢失时按原运行 ID 恢复，避免重复模型调用。主界面提供任务输入、运行状态、项目切换、新建项目和结果入口；新建流程和新增智能体自动连线。文件预览使用无同源权限的 sandbox，归档读取不释放文件到服务器目录。S3 读写验证可以在关闭自动同步的状态下进行。

## 4.0 三 AI 接入

| 入口 ID | 位置与执行器 | 默认模型 |
| --- | --- | --- |
| `deepseek-shanghai` | 上海 DeepSeek Harness ACP | 沿用现有配置，验收返回 deepseek-v4-flash |
| `codex-silicon` | 硅谷 Codex ACP | gpt-6.1-sol |
| `claude-silicon` | 硅谷 Claude Code ACP | 沿用已登录账户默认模型 |

网页任务框上方选择项目默认入口；智能体配置中的「服务器与 AI」覆盖单个节点。新建项目可直接选择「DeepSeek 规划 → Codex 开发 → Claude 审查」。JSON 中项目级字段是 `executionProfile`，节点中同名字段表示该节点的覆盖设置，留空继承项目。`custom` 使用原有高级连接设置。MCP 可用 `canvas_list_profiles` 发现入口，`canvas_start_run` 的 `profile` 可覆盖项目默认入口。

真实私有入口配置位于 `/etc/openhands-control/ai-profiles.json`，由 `CANVAS_AI_PROFILES_PATH` 指定；示例见 `config/ai-profiles.example.json`。不要把真实服务密钥写入示例或仓库。配置还会加密保存在 SQLite 中，包含在数据库备份内；接口只返回 ID、名称、位置、模型和验收时间。

任务提交时固化每个节点的入口配置，历史任务恢复继续使用原服务器。跨服务器阶段会通过受保护的官方文件 API 交接工作目录，校验归档路径，跳过符号链接；同一服务器、同一目录直接共享文件。单文件交接上限 32 MiB，目录合计 128 MiB，常见生成目录沿用 Agent Server 的默认排除规则。失败会停在交接节点，重试不会重跑已完成节点。最终下载包含最后一个节点所在服务器上的合并产物。

部署后台使用 `sudo bash ops/deploy-control.sh` 同时安装 server 与 shared，保留私有环境文件。网页构建后更新 `/opt/openhands-control/dist/server/index.js` 并重启 `openhands-web.service`；Sites 镜像仍按原项目 ID 发布。

真实三节点验收项目：`6f2c54fa-2103-488b-b1b5-436059637d96`，运行：`c021c84f-2e70-4990-a9b2-edd4a712d634`；产物包含 DeepSeek 的 PLAN.md、Codex 的 index.html 和 Claude 的 REVIEW.md。

### 五 AI 融合

新建项目仅建立自主规划种子，由已验证的最强可用模型按需求决定人数、职责、依赖和并行。默认精简协作，实干节点可做必要检查后直接交付；所有跨服务器成果经数据桶快照交接，每运行和全局最多五个 AI 节点并发。旧的固定八阶段仅作为历史模板兼容。

五个入口 ID：`deepseek-shanghai`、`codex-shanghai`、`codex-silicon`、`codex-seoul`、`claude-silicon`。用 `canvas profiles list` 查询，用项目或节点的 `executionProfile` 指定。三个 Codex 是各服务器上的独立执行实例；融合是统一调度、共享产物和阶段交接。

首尔服务为 `openhands-seoul.service`，本机监听 18181；硅谷通过 `openhands-seoul-tunnel.service` 将其接到本机 18084，再由受 API Key 保护的 HTTPS `/seoul/` 路由访问。配置参考 `ops/openhands-seoul.service` 和 `ops/openhands-seoul-tunnel.service`。不要直接向公网开放 Agent Server 端口，也不要更改服务器原有登录配置。

五 AI 真实验收项目：`82ff9b7e-1c42-4b82-a1d0-d8498e07666d`；运行：`ab089a46-0895-4901-b133-156fb3fcbd06`。五个节点全部成功，最终产物为 `PLAN.md`、`DESIGN.md`、`index.html`、`TEST.md`、`REVIEW.md`。首尔执行了 Node 页面脚本测试，工作台还通过了手机和桌面浏览器验收及计数按钮实际点击测试。上海 Codex 与首尔 Codex 在本轮使用各自账号可用的 `gpt-6-astra`，硅谷 Codex 使用 `gpt-6.1-sol`，原生 CLI 配置保持原状。

### 七彩云：环境变量接入与只读验收

连接参数：Endpoint `https://s3.7caiyun.com`、Region `us-west`、完整桶名 `zzx123-u1aya4fk`，AWS Signature V4。按官方示例使用 Virtual Host Style（`forcePathStyle: false`），必要时可在环境变量中切换 Path Style。

密钥仅由控制器环境变量提供，不写进项目、网页或 SQLite 备份。硅谷主机的 root 私有文件 `/etc/openhands-control/s3.env`（0600）由 systemd 的 `ops/openhands-s3.conf` 加载。

在硅谷终端执行 `sudo python3 /opt/openhands-control/ops/configure-qicai-s3.py`，按隐藏提示输入两项密钥，再执行 `sudo systemctl restart openhands-control`。也可先设置 `CANVAS_S3_ACCESS_KEY_ID`、`CANVAS_S3_SECRET_ACCESS_KEY`，使用 `sudo --preserve-env=CANVAS_S3_ACCESS_KEY_ID,CANVAS_S3_SECRET_ACCESS_KEY python3 /opt/openhands-control/ops/configure-qicai-s3.py --from-environment`。不要将密钥放入命令参数。

首次验收运行 `canvas storage list --limit 20`。`--prefix` 筛选桶内对象，`--cursor` 传入上一页返回的 `nextCursor`。网页设置的「S3 对象存储 → 列出桶内文件」和 MCP 工具 `canvas_list_storage_objects` 使用同一个只读接口，返回文件名、大小和修改时间；默认列整个桶，不局限于工作台同步前缀。

`CANVAS_S3_READ_ONLY=true` 时不会自动同步、上传备份或执行写入/删除测试。只有配置密钥并成功完成真实 `ListObjectsV2` 请求后，才能认定已连接。之后如需启用项目、产物与备份写入，再将此变量改为 `false`、重启控制器并在网页启用同步。

变量也兼容官方示例名 `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`；`CANVAS_S3_*` 优先。私有配置文件缺失不会影响 AI 工作流。

参考：[七彩云接入参数](https://docs.7caiyun.com/developer/dev-connection-params)、[官方 SDK 示例](https://docs.7caiyun.com/developer/dev-sdk-examples)。

### 手机查看，Codex 聊天操作

手机宽度下默认展示项目查看页：运行状态、五 AI 阶段、交付文件预览与下载、最近动态。任务创建、AI 分工和执行主要通过 Codex 的 MCP/CLI 完成。手机每 6 秒检查服务器项目和最新运行，活动运行继续按现有频率同步进度；切到后台会暂停额外刷新，回到前台继续。Codex 新建其他项目时会出现项目更新入口。查看历史运行时会保留所选记录，可选择重新跟踪最新运行。

「修改说明」仅修改项目名与任务说明，保留所有节点、AI 入口和连线，不启动任务；执行期间禁用。保存使用版本校验，Codex 同时更新项目时不会覆盖服务器新版本。更多操作保留完整编辑器和停止入口，电脑端继续展示画布。

Codex 可用 `canvas_update_project_details` 做同样的轻量修改，传入 `canvas_get_project` 返回的 revision；创建和执行继续使用既有工具，所有入口共享同一项目和运行记录。

手机浏览器集成验收：先构建，再安装或使用已有 Playwright，运行 `npm run test:mobile`。也可将 `PLAYWRIGHT_MODULE` 指向已安装模块。此检查使用独立 SQLite 和模拟运行，不调用真实模型，覆盖自动发现运行、并发修改冲突、历史记录固定、文件预览与手机/桌面布局。

### 五 AI 协作数据进入七彩云桶

生产环境现已授权启用自动同步，桶为 `zzx123-u1aya4fk`，统一前缀 `openhands-canvas/`。原先首次连接的只读设置已切换为协作数据写入，密钥仍只在控制器环境变量中。轮换密钥不会重置此模式；部署工具的 `--enable-sync --config-only` 可以保留密钥并解除只读，之后在工作台设置启用同步。

- `projects/<项目>/versions/` 与 `latest.json`：项目配置与版本。
- `runs/<运行>/input.json`、`state.json`：任务、五 AI 分工、状态和阶段输出。
- `runs/<运行>/events/`：分批增量日志，`index.json` 记录最新序号。
- `runs/<运行>/stages/<节点>/workspace.tar.gz` 与 `manifest.json`：新运行每个阶段完成后的文件快照、SHA-256 校验值和交接说明。
- `runs/<运行>/artifacts.tar.gz`：最终交付文件。
- `backups/`：每日一致性 SQLite 备份，其中执行凭据保持加密。

每个新阶段完成后先把工作目录快照存入桶，再启动后续阶段。跨服务器从桶下载上一阶段快照并校验大小与 SHA-256，然后恢复到下一台服务器的本次工作目录；同服务器同目录阶段可直接继续操作本地文件，各阶段仍分别保存快照。上传失败时保留已完成节点，继续操作只重试文件保存。旧运行的最终产物和记录也会同步；不会伪造其过去各阶段的历史快照。

项目、运行和日志按 15 秒周期同步，每日备份一次。服务器继续保留执行工作目录和缓存，S3 承担跨服务器交接与持久存储。完成产物的本地缓存丢失后，可从桶恢复，不依赖原 AI 服务器在线。S3 密钥不发送给五个 Agent，也不写入项目 JSON；加密主密钥继续由服务器单独保管。

`npm test` 包含独立的五阶段桶交接测试：模拟三地执行端和 S3 协议端，验证阶段快照、下载交接、上传失败后的安全重试、日志分页、备份以及原执行端离线时的产物恢复，不产生模型调用。

### 配套插件和后续升级

现有同名私有插件已经升级为 2.2.0，包含五 AI 工作流技能、模板、数据桶规则、轻量修改规范、升级指引和 CLI 备用入口。插件仍连接同一个网站和同一后台；App ID、plugin ID、绑定方式与可见范围保持原样。账号的插件技能版本与网站版本独立演进。

在网站「设置 → 通过 Codex 操作」可以查看配套版本、打开账户中的插件，或下载完整私有更新 ZIP。`canvas_plugin_info` 可供聊天读取配套信息。网站下载需要工作台登录，包中没有服务器程序、运行数据或真实密钥。

维护源码位于 `plugin/dev-dd1b08996ae8819185f83397876ccbb5/`，已保留 App 生成的旧版清单以完整保留既有绑定和展示信息。升级步骤：修改技能/模板并增加清单 SemVer → `npm run plugin:pack` → 用 Plugin Creator 读取当前 release 并带 expected_release_id 更新现有插件 → 把返回的版本/release ID/plugin_url 记入 `plugin/release.json` → `npm run build && npm test` → 发布现有 Site。发布后回读插件文件，验证技能保留，再做真实插件只读调用。

构建同时打包 ZIP 和网站内的版本信息；版本与 `plugin/release.json` 不一致会停止构建，避免网站下载到不配套的包。打包也检查保留的 App 配置、五阶段模板、工具契约、支持文件与 CLI 一致性。账户更新时必须重新读取线上 release ID，不直接使用旧的本地记录覆盖。

### 硅谷 Codex 插件列表的本地安装

账户中的私有插件与硅谷 Codex 当前能发现的目录可能不同。硅谷已通过仓库的 `.agents/plugins/marketplace.json` 注册来源「OpenHands 工作台」，安装并启用同一份 1.1.0 插件。云端 App ID 与网站连接保持原样，没有创建第二个云插件。

后续在这台机器执行 `npm run plugin:install-local` 可安装或刷新本地副本。升级源码中的插件版本后，再运行该命令；它会调用 Codex 官方安装命令并检查命令行安装状态。Codex CLI 中使用 `/plugins` 查看；插件显示名称为「OpenHands · Agent Canvas」，来源名为「OpenHands 工作台」。新 CLI 会话可加载新技能和工具。

手机 Codex 连接硅谷时，不能把 CLI 安装成功当作手机插件列表已显示的证据。2026-10-26 已直接检查正在运行的 Android 远程连接服务（0.164.0）：默认插件目录包含已安装且启用的本地插件，私有目录也返回同一个 1.1.0 云插件；当前会话的 App 为 enabled/callable，真实 MCP 调用成功读取 7 个项目及数据桶状态。手机界面的可见性仍需单独确认。排查时区分「OpenHands · Agent Canvas」显示名称与来源名称，并使用既有私有插件入口；不要重复创建插件或仅为刷新列表重启正在承载会话的服务。

### 接入引擎 5.0 / 插件 2.0

网站顶部「接入引擎」集中管理连接、操作、跨服务流程和调用记录。五个原有 AI 与工作台数据桶自动出现；可新增 OpenAI 兼容 API、Anthropic、多个 S3 桶、GitHub、WebDAV、Google Drive、OneDrive 和通用 HTTP/OpenAPI 3 连接。外部账号配置有效凭据并通过测试后才算连接成功。

连接默认只读；启用写入/AI 执行由连接策略控制，API 仍检查 read/write/run 令牌权限。凭据加密保存，或引用控制器 CANVAS_ENGINE_ 前缀环境变量；其他外部变量由 CANVAS_ENGINE_ALLOWED_ENV 显式允许，内部服务密钥不可引用。Google Drive、OneDrive 使用用户提供的 OAuth Access Token（过期后更新或由环境管理）；WebDAV 使用用户名/密码。不在浏览器存储或插件中保留密钥。

Codex 使用 canvas_engine_* 工具，或命令行：

```sh
canvas engine types
canvas engine connections list
canvas engine connections put --id my-api --file connection.json --revision 0
canvas engine connections test --id my-api
canvas engine invoke --connection my-api --operation list --id unique-request --file input.json
canvas engine jobs wait --id unique-request
canvas engine pipelines put --id repo-ai-drive --file pipeline.json --revision 0
canvas engine pipelines run --id repo-ai-drive --run-id unique-run --file input.json
canvas engine export
```

操作定义与跨服务流程示例见 [引擎说明](plugin/dev-dd1b08996ae8819185f83397876ccbb5/skills/openhands-collaboration/references/integration-engine.md)。支持 HTTP(S) 相对路径、认证、查询、Header、JSON/文本请求体及 OpenAPI 3 的常用 Schema；不把“通用”表述为无需授权或自动理解任意协议。非 HTTP 接口通过 HTTP 网关或源码适配器扩展。

后台调用使用唯一请求 ID 幂等提交；调用、结果与流程版本持久化。服务重启把未完成请求标记为 interrupted，不自动重放可能已执行的外部写操作。AI Agent 的链接运行 ID 可继续在工作台跟踪。引擎配置和调用记录自动进入原数据桶 engine/ 路径，密钥只存在加密数据库备份中。协议与恢复验收运行 `node scripts/test-engine.mjs`；完整检查使用 `npm run build && npm test`。

### 五 AI 开发项目（5.1）

日常在 Codex 里说明项目名称和需求，five-ai 快捷创建仅建立自主规划种子。由已验证的最强可用模型（优先 GPT-6 Astra）按需求决定实际人数、分工、依赖和并行；没有固定八阶段。保存不调用模型，执行用 canvas_start_run / canvas runs start。默认精简协作，开发节点可做必要检查后直接交付。网页、后台和插件使用同一模板。

项目可用 `/?project=ID&run=ID` 直达，登录后保留选择；历史运行不会被手机自动切换回最新。手机提供停止和继续未完成阶段，已成功的 AI 不会重复调用。处于等待输入状态的任务也可停止。

每个已完成阶段的 S3 快照都可查看和下载，失败时仍能取回已有代码；界面明确标记“阶段文件、尚未完成验收”。只有整个运行 succeeded 才是最终交付。单文件下载支持文本和二进制（8 MiB 上限），较大文件使用完整产物包。

静态网页预览支持本地经典 JS、CSS、图片和按运行隔离的本地保存，也支持交付网页中的 JSON 导入/导出、确认框。预览始终禁止同源访问工作台；最多内联 24 个本地资源、总计 8 MiB，存储桥上限 1 MiB。不处理复杂模块构建或后端服务，这类项目按 README 运行。

浏览器检查使用本机 HTTPS 测试服务，实际经过浏览器 Cookie、登录重定向和隔离 iframe，不依赖虚构域名的重定向拦截：

```sh
npm run build
npm test
npm run test:mobile
npm run test:engine-mobile
npm run test:preview
CANVAS_ARTIFACT_DIR=/path/to/extracted-board npm run test:real-development
```

后三类浏览器检查需要 Playwright/Chromium，可用 PLAYWRIGHT_MODULE 指定现有安装。真实项目验收记录见 [五 AI 实战验收](docs/development-verification.md)。

### 并行协作引擎（5.2）

默认模板保存在 shared/five-ai-workflow.json；网页、服务器及插件共用相同分工和 DAG 连线。旧串行运行继续可读，旧项目不会自动改写自定义分工；新建五 AI 项目使用并行模板。既有标准项目可在读取 revision 后替换成该模板，保留原任务再保存。

每个节点在 runs/<运行>/<节点> 中独立工作，避免共享目录并发写入。依赖只在上游模型完成、快照校验和配置的数据桶上传全部成功后解锁。汇合基于共同祖先进行三方合并：互不冲突修改直接合并，未修改的旧副本不会覆盖其他分支新代码；删除和二进制也保留。冲突副本位于 .canvas-collaboration/inputs/，汇合清单 handoff.json，解决记录 resolutions.json 的最终 SHA-256 必须通过后台验证。没有明确共同基线的复杂汇合会要求添加整合节点。

桶路径新增 runs/<运行>/inputs/<节点>/workspace.tar.gz 和 handoff.json，用于留存各分支输入及汇合证据。各成功节点仍有 stages/<节点>/ 的快照与校验。modelCompleted、snapshotReady、outputReady 分别记录模型、文件和持久化屏障，重试存储不会重放成功模型。停止会等待全部在执行分支确认；手机同时显示多个 AI 状态，完成数按节点实际状态统计。

npm run test:parallel 使用本地真实 HTTP AgentServer/S3 协议 fixture，覆盖并发上限、文件隔离、共同祖先合并、冲突及校验、全部依赖屏障、失败重试、停止及控制器重启，不调用真实模型或生产桶。

并行调度的实际五 AI、数据桶与手机验收见 [并行验收记录](docs/parallel-verification.md)。汇合 handoff.json 记录直接来源、完整上游 lineage、模型/服务器、提交和完成时间及阶段 SHA-256，供整合与审查追踪。

### 运行速度优化（5.2.1）

文件只解压一次并共享四路上传；同一桶快照合并并发读取并复用校验后的副本，S3 连接复用；无变化轮询不写库；登录后的静态资源通过 ETag 复用，项目数据仍不缓存。五 AI 分工、快照屏障与测试要求保持原样。前后 HTTP 基准和真实七彩云只读结果见 [速度验收](docs/performance-verification.md)。

### 模型与思考模式（5.3）

手机「模型模式」或 Codex 聊天支持自动、速度优先、均衡、深度、手动。自动按任务难度和阶段职责选取已验证模型；审查、集成与冲突处理提高深度，其他工作可用轻量模型。DeepSeek 固定 V4.1 Flash + max，所有档位一致。可先预览每节点选择，保存不调用模型，新任务生效，续跑保持原设置。

CLI：`canvas models preview --project ID --mode fast`、`canvas models set --project ID --mode auto`。完整 state 使用 modelMode、reasoningEffort、taskComplexity；节点 liveModel/reasoningEffort 可覆盖。实际能力来自各入口 policyModels 目录，verified=true 必须有真实小任务依据；列表存在不等于账号可调用。Fable 不参与自动选择。

原生 ACP 桥 ops/acp-policy.py 只对本次进程设置参数，不写全局账号配置；会话确认后写入包含 requestId 的 .canvas-collaboration/runtime-selection.json，阶段交接校验后入桶。新部署需将脚本安装到各 Agent 工作根目录/.canvas-runtime/。测试：npm run test:model-policy；手机模式测试 npm run test:model-policy-mobile（需要 Playwright）。

### 按需求自主协作（5.4）

新建五 AI 项目默认由 AI 根据需求决定实际人数、职责、入口、依赖和并行方式，不再固定安排前端、后端、测试与审查四路。规划结果位于 `.canvas-collaboration/plan.json`，包含目标、分工理由、验收标准和阶段。引擎校验可用入口、依赖、文件基线和并行上限后扩展本次运行；规划完成与实际实现分开记录。主要实现和集成完成后才启动集中测试、修复、验收与交付。简单需求可少用 AI，独立工作可并行。手机继续查看实际运行阶段，无需增加编排操作。

协作计划与分支产物经过桶快照屏障；生成的运行图及配置在同一数据库事务内保存，重启/续跑不重复扩展。无效计划不能启动开发分支，续跑重新规划；成功实现阶段的存储重试不重复推理。历史固定工作流仍可运行，参考 `shared/fixed-five-ai-workflow.json`。

### 精简协作（5.5）

默认 coordinationPolicy=lean，以实现需求为主。一个开发节点即可交付；verify/deliver 可省略，独立检查/交付节点合计最多一个。独立分支可由引擎自动合并，不额外调用 AI 写验收报告。有实际依赖或冲突才安排集成。必要检查在实现后完成，失败后定点修复，文档按实际使用需要更新，不强制生成流程报告。

精简模式将交接正文限制为每上游约 1400 字符、合计 5000 字符，完整文件仍在已校验的快照中。职责只在用户消息中完整提供，系统提示保持简短；规划目录只列入口，不重复注入模型能力列表。深度模式与 DeepSeek V4.1 Flash + max 的用户设置保留。旧运行继续使用原配置。

### 强规划者与 GitHub 授权（5.6）

默认 plannerPolicy=strongest，规划优先选已验证的 GPT-6 Astra，首选硅谷 Codex、再用同模型其他入口；不可用时仅回退到其他已验证的强模型，目录为空则报告问题。规划只决定需求分工一次，执行仍按模型模式分配，DeepSeek 固定档位保留。plannerPolicy=manual 可保留用户明确指定的规划入口。

GitHub 连接名称、配置写权限与凭据状态分开显示。未配凭据可以按 owner 读公开仓库，写操作明确不可用；账号测试读取 /user，公共接口测试不宣称登录。配置 owner 可约束目标，PAT 仍须有对应仓库权限。Codex GitHub App 与后台 PAT 为独立连接。

### 5.11 / 插件 2.10：真实耗时与存储恢复

`canvas runs performance --id RUN_ID` 返回队列、准备、模型、快照与桶屏障时间，并区分并行模型墙钟时间和累计工作量。MCP 可使用 `canvas_run_status({id,view:"performance"})`，不返回提示词或模型输出。历史未知值保持 null，完整规则见 [运行耗时](docs/run-performance.md)。

文件上传的临时网络或服务端错误会重新打开文件流重试一次；已写入的阶段归档或清单有独立持久化回执，恢复时只补缺失部分。授权拒绝直接失败；未通过两个对象的确认前不交付，也不会重复调用已经完成的 AI。实际 AI 开发比较脚本为 `scripts/benchmark-real-development.mjs`（需显式 --allow-real-models，绝不作为升级验收）。整体提速 1000% 尚未得到实际任务证据证明。
