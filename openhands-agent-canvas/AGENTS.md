# OpenHands Canvas · Codex 操作指南

5.28 / 插件 2.25：新的 DAG 运行冻结 textMergeVersion=1，同一共同基线的 UTF-8 文件可按互不重叠的行修改自动汇合，不另叫整合 AI。负责人仍决定职责、共享接口与必要检查；真正重叠、竞争插入、删除/修改、二进制、模式变化及超出资源限制继续保留各版与显式解决。节点 mergeReport.autoMerged / run.finalMerge 返回来源与结果哈希。历史运行不改策略；增量重建沿用来源策略。见 docs/text-merge.md，不把文本合并成功当成语义检查通过。

5.27 / 插件 2.24：支持 strongest 负责人提前冻结计划与接口，经原始输入及提前快照的 SHA/桶屏障后，在原会话继续自己的实现，同时释放独立分支。是否使用由负责人选择；planCommitted 只表示可交接，负责人实际 modelCompleted/outputReady 才表示完成。artifactOnly 文件结果节点不调用模型，最终 verify/deliver 等待其完整成果。停止、重启、续跑和增量开发保留实际会话与双方文件，接口或计划变化不能静默通过。见 docs/streamed-plan.md；未测得真实任务整体 11 倍。

5.26：实际需求需要最终命令时，可设置 deliveryValidation={command,timeoutSeconds:60,autoRepair:true}（默认不配置，不例行增加验收）。全部成果经 SHA/桶屏障后在独立目录执行，真实失败才由原已验证强负责人继承成果定点修复一次，再跑同一检查；第二次失败停止。查看 run.deliveryCheck 的回执及修复计数。连接异常不触发 AI 修复，命令或模型的完成回执跨恢复保留。MCP start 支持单次覆盖，CLI 使用 --validation-file；依赖准备写入检查命令。详见 docs/delivery-validation.md。

5.25：新自主协作运行按剩余依赖路径优先占用空闲推理槽，负责人可填写阶段 estimatedSeconds（1–7200 整数秒，预计时间而非预算）。模型、深度、分工与依赖仍由负责人决定；估计及来源与计划同事务冻结在 run.scheduling，续跑不重估，未知值保持 null。文件与桶屏障不变，固定/历史运行保持原顺序。见 docs/critical-path.md。

这是可真实执行任务的工作台。通过 `canvas` 命令行或此网站的 MCP 插件操作，网页、CLI 和 MCP 共享项目和后台任务。

## 连接

- 上海、首尔、硅谷均已安装 `canvas`，主要入口为 `https://canvas.43-173-109-57.sslip.io`。先用 `canvas projects list` 检查连接。
- 其他机器运行 `node bin/canvas.mjs login`，在交互提示中填写网站地址和网站设置生成的令牌。
- 密钥只读环境变量或 `~/.config/openhands-canvas/credentials.json`，权限必须为 600。不要将令牌放在命令参数、仓库或对话中。
- MCP 通过 Sites 为此网站创建的同名插件连接。在网站设置生成连接码，再调用 `canvas_connect`。不要另建重复插件。

## 操作顺序

1. `canvas projects list`，再 `canvas projects get --id ID` 读取工作流和 revision。
2. 修改节点、提示词、任务、连线后，使用 `canvas projects put --id ID --file workflow.json --revision N` 保存。新项目 revision 为 0；409 时重读并合并，不能盲目覆盖。
3. 用户要求执行时，使用 `canvas runs start --project ID --id UNIQUE_REQUEST_ID`。这是实际模型调用；同一个提交重试要保留 ID。
4. 使用 `canvas runs get --id ID` 或 `canvas runs wait --id ID` 跟踪。关闭终端不会停止任务。
5. `canvas runs events --id ID --after CURSOR` 读取日志，`canvas runs files --id ID` 列出产物，`canvas runs file --id ID --path index.html` 读取文本文件；有 hasMore 时继续分页。
6. 完成后使用 `canvas runs artifacts --id ID --output result.tar.gz` 下载产物，验证实际文件。仅凭 OpenHands 的 finished 字段不能判断模型成功，工作台会检查 provider 错误和节点输出。
7. 停止使用 `canvas runs stop --id ID`，等待状态 cancelled；不要将 stopping 当作已停止。重试使用 `canvas runs resume --id ID`，已完成节点不会重复调用。

节点类型 start/end/planner/research/code/review/custom。节点必填 id/type/name/x/y，智能体可以设置 prompt/tools/liveModel。edges 为 `[sourceId,targetId]`，不能有环，智能体必须能从 start 到达。任务写在 state.task 中，输出文件写入服务器分配的本次工作目录。

默认硅谷 Codex ACP 使用已验证的 gpt-6.1-sol，上海 Codex / DeepSeek、硅谷 Codex / Claude、首尔 Codex 共五个入口已接入。使用 `canvas profiles list` 查询入口。项目和节点的 `executionProfile` 分别控制默认入口和单节点入口；三 AI 模板为 deepseek-shanghai → codex-silicon → claude-silicon；五 AI 新项目由已验证的最强可用模型（优先 GPT-6 Astra / 硅谷 Codex）根据需求自主规划，启动后生成实际分工及 DAG，再执行需求实现、必要集成、最后测试与交付。历史固定工作流继续兼容。跨服务器文件会自动交接，凭据保留在服务端。更改执行模型先做小任务验证；模型列表展示不代表账户可用。不要改动服务器原有 Codex/Claude 账户配置、代理凭据或其他项目服务。

## 项目开发

Node.js >=22.16，先 `npm ci`。`npm run build && npm test` 检查 Worker、后台队列、加密、鉴权、恢复与 MCP。发布保留 `.openai/hosting.json` 中的 Site ID，使用 Sites 源码工作流；后台代码在 `/opt/openhands-control`，服务 `openhands-control.service`。运行中的真实任务需要先检查，服务重启只用于必要升级或明确的恢复验证。

对象存储配置在网页设置完成，凭据加密保存在 SQLite。不要导出真实凭据到项目 JSON。恢复备份遵循 README，先恢复到独立目录验证；不要覆盖正在运行的数据库。

七彩云对象存储使用控制器环境变量。用户已授权将五 AI 协作数据写入桶，生产环境已启用自动同步和每日备份。首次接入其他桶仍先做只读列举。`canvas storage list --limit 20` 列出桶内文件，`--cursor` 翻页。网页和 MCP 的 `canvas_list_storage_objects` 也可只读列举。密钥未配置或列举权限不足时必须如实报告，不能宣称连接成功；不要调用写入测试、同步或备份代替首次只读验收。

## 本项目的使用偏好

优化优先级：引擎能力优先，用户界面保持简单。用户要求减少审查、验收、风险报告和重复测试的 token 消耗，多投入实际实现。默认不另设审查员、不强制生成 PLAN/CONTRACT/TEST/REVIEW 文档；按需求只做必要检查，说明简短，已有说明确需变更时更新。主要投入五 AI 真正并行协作、按能力分工、模型与思考深度调度、上下文与文件交接、冲突合并、失败恢复、执行速度和资源利用。以实际任务成功率、耗时、重复调用和产物验证衡量效果。界面只为清楚查看状态、错误、产物和必要的轻量修改做调整，避免反复美化、增加复杂操作或要求用户手工编排。主要操作入口继续是与 Codex 聊天，手机主要用于查看。

用户主要通过与 Codex 聊天操作工作台。直接使用 MCP/CLI 完成创建项目、安排五 AI 分工、启动、跟踪和查看产物，不要求用户在手机上编辑画布。手机默认是查看界面：项目、阶段进度、文件预览、下载和少量说明修改。手机端会自动发现 Codex 创建的新运行及项目版本；查看历史运行时保留所选记录。

只改项目名称或任务说明时，先读当前项目及 revision，然后用 `canvas_update_project_details`，保留图、AI 入口及节点提示词；此操作不触发模型调用。修改任务并执行时，继续调用 `canvas_start_run` 并使用唯一运行 ID。完整流程修改仍用 `canvas_save_project` 或 CLI `projects put`，遵循版本冲突处理。

协作数据保存在 `zzx123-u1aya4fk/openhands-canvas/`：项目版本、运行输入和状态、增量日志、阶段文件快照、完整产物和数据库备份。新运行每个节点成功后必须先保存阶段快照；跨服务器交接从桶下载并校验 SHA-256，然后交给下一个 AI。对象存储故障时，重试不得重新调用已经完成的节点。不要把服务器执行工作目录当作桶挂载，也不要在五个 Agent 中分发 S3 密钥。

配套插件保持 ID `plugin_asdk_app_sites_dd1b08996ae8819185f83397876ccbb5`，源码在 `plugin/dev-dd1b08996ae8819185f83397876ccbb5/`。使用 Plugin Creator 更新现有插件，禁止新建重复插件。`npm run plugin:pack` 验证并打包；更新账户后把返回的版本、plugin_url 和 release_id 写入 `plugin/release.json`，再构建/发布现有 Site。网站自动嵌入相同源码的 ZIP 和版本信息，版本不匹配会阻止构建。App 生成的绑定与展示信息由 `plugin/preserved-app-metadata.json` 校验并保留。插件升级不改运行环境文件、数据桶或服务器登录。

硅谷原生 Codex 已注册本地来源 `openhands-canvas`（界面名「OpenHands 工作台」），选择器 `dev-dd1b08996ae8819185f83397876ccbb5@openhands-canvas`。后续更新本地安装使用 `npm run plugin:install-local`；不直接修改插件缓存。不要把账户云插件已发布误报为所有服务器原生 Codex 都已安装。

用户从手机 Codex 连接硅谷。插件本身显示为「OpenHands · Agent Canvas」，不要混同来源名「OpenHands 工作台」。CLI 安装检查、正在运行的远程服务目录、手机界面显示要分别验证。2026-10-26 已只读检查实际 Android 远程服务的默认/私有插件目录、技能和当前会话 App，安装与调用正常，手机列表显示尚未确认。不要仅凭另起的 app-server 进程或 CLI 检查就说手机已修好；当前执行工具依赖同一个远程服务，避免为了刷新插件强制重启它。

## 通用接入引擎

网站 5.0 / 插件 2.0 新增 /engine API。连接目录包含内置五 AI、七彩云桶，以及可配置的 openai、anthropic、s3、github、webdav、google-drive、onedrive、http（OpenAPI 3）。用 canvas_engine_connections 或 canvas engine connections list 发现，不能把支持类型说成已授权的账号。配置需当前 revision；新连接默认只读，写入/推理依用户授权开启。凭据使用网站密码表单或控制器环境引用，不发到聊天。

跨服务编排用 engine pipelines；步骤输入引用 {{input.field}} / {{steps.id.data.field}}。所有调用后台持久化并使用唯一 ID 去重；interrupted 表示结果不确定，先核对，不自动换 ID 重放。AI 内置连接的 run 操作返回 linkedRun，可用原运行 API 跟踪文件。只读测试不产生模型调用或外部写入。协议、权限、凭据、分页、恢复和数据流验收在 scripts/test-engine.mjs；桶同步复用原有每日备份和环境文件。

## 五 AI 并行开发的日常入口（5.2）

用户优先要五 AI 协作开发项目。使用 canvas_save_project({id,expectedRevision:0,state:{preset:"five-ai",title,task}}) 创建默认自主协作项目，再按用户要求使用唯一 run ID 开始；CLI 对应 canvas develop create。shared/five-ai-workflow.json 为自主规划种子（collaborationMode=adaptive，start→plan→end）。plannerPolicy=strongest 选择已验证的最强可用模型先按需求决定人数、职责、入口、并行及汇合时机，输出 .canvas-collaboration/plan.json；引擎校验后扩展当前运行的 DAG。默认 coordinationPolicy=lean，以实际实现为主。1 个 build 即可完成，verify/deliver 可省略、合计最多一个；确需 verify 时等全部 build/integrate 完成。实干节点做必要的小检查即可直接交付；不固定前后端/测试/审查四路，也不为凑齐五个 AI 增加无关工作。必要的实现阻塞可做最小检查，验证只覆盖实际改动，失败后定点修复，不例行全面复核。DeepSeek 仍固定 V4.1 Flash + max。项目保存不执行；运行生成的分工保存在运行和数据桶，不盲目覆盖项目及历史。固定旧模板保存在 shared/fixed-five-ai-workflow.json。

交付时给 /?project=ID&run=ID 直达链接，读取实际文件并验证主要交互。未完成运行可从最近一个成功阶段快照读取/下载代码，partial=true 必须说明尚未完成验收。预览桥支持隔离存储和静态本地依赖，不能给 iframe 增加 allow-same-origin。单文件下载为 /api/runs/ID/file-download?path=...，只以附件响应。等待输入的任务也允许请求停止，仍须后台确认取消。

并行调度由 server/engine.mjs 按 DAG 依赖执行，历史串行运行由 serial-engine.mjs 兼容。每节点独立目录；outputReady 代表文件快照通过校验及配置的桶写入屏障，不能只看 succeeded 就启动下游。运行/全局节点上限五个；maxActive 是工作流上限。状态更新必须读最新运行再仅合并本节点，禁止并发分支保存过时的整轮 payload。同文件冲突保留分支副本和显式 SHA-256 解决记录；所有分支确认停止后才可 cancelled。测试 npm run test:parallel 覆盖实际 HTTP 协议并发、隔离、三方合并、重试、停止和重启。

5.2.1 加速：文件交接共享四个上传槽、32 MiB 原文件缓冲与两个归档进程，只解压一次。restoreCheckpoint 默认刷新远端；执行/预览可显式 reuseVerified=true，首次桶下载和每次本地 SHA 校验不得省略。S3 client() 返回 send/destroy 借用对象，destroy 释放连接而非关闭共享池；请求结束、错误和取消都必须释放。patchNode 无变化不写库。静态资源可 private/no-cache + ETag，HTML/API 仍 no-store 且先做鉴权。性能测试 npm run test:performance；不为升级启动真实 AI。

## 模型与思考模式（5.3）

使用 `canvas models list` 查询实际入口能力，`canvas models preview --project ID --mode auto` 只预览，`canvas models set --project ID --mode fast` 按 revision 保存完整流程。五档 auto/fast/balanced/deep/manual；自动选择只用 verified=true 的模型，按任务难度和验收/集成阶段选择；文件冲突可升级。每节点 liveModel/reasoningEffort 可覆盖其他 AI，DeepSeek 始终固定 DeepSeek V4.1 Flash + max，不得改 Pro 或降低。modelSelection 是计划，selectionApplied 才表示会话已确认。续跑冻结原运行选择。原生会话使用 ops/acp-policy.py 设置并确认模型和深度，回执与 conversationId 绑定并进入桶快照；部署新服务器时把脚本安装到其工作根目录/.canvas-runtime/acp-policy.py，不改原有登录配置。

GitHub 名称与授权状态必须一致：readOnly=false 表示配置允许写，凭据是否存在与真实仓库权限单独核实。优先使用 Codex 已连接 GitHub 操作用户自有仓库；网站后台需要独立凭据，不能把聊天授权说成后台已授权。缺凭据时写操作应 unavailable，测试公共 rate_limit 不代表登录成功。创建项目工具描述必须与自主分工和精简策略一致，不再描述固定八阶段。

## 执行加速（5.7）

已安装并校验的 bulkHandoff 入口通过流式上传整包和原生命令导入，固定两次请求；每次执行校验 helper SHA-256、源归档 SHA-256、目录范围和提交回执。只用于隔离的 runs 目录，禁止符号链接，原目录在导入成功前保留。入口未配置则沿用旧文件协议。服务器安装使用 `node ops/install-fast-handoff.mjs /受保护的/profiles.json`，保留原文件属主、组和权限；配置中不导出密钥。代理归档上传上限 130 MiB，单文件/工作区仍为 32/128 MiB。

所有控制器归档处理共用两个进程槽；三方合并将大文件放临时磁盘，全部父分支合计最多缓存 8 MiB 内容，保持 SHA-256 冲突语义。输入快照存储与模型执行重叠，输入、输出与元数据都成功保存后才允许下游运行；存储失败只重试存储。模型完成即释放全局推理名额。已验证 eventStream 的入口使用 `/sockets/events/ID` 和首帧认证唤醒，密钥不放 URL；REST 分页和错误检查仍决定完成，断开后沿用轮询。节点 inputReadyAt / snapshotReadyAt / outputReadyAt 与既有 submittedAt / finishedAt 可区分执行和编排耗时。

性能结论必须注明范围：`scripts/benchmark-native-handoff.mjs` 为三服务器真实文件传输；`scripts/benchmark-pipeline.mjs BASELINE_DIR` 为完整引擎和协议夹具、固定模型响应时间；`scripts/benchmark-merge-memory.py BASELINE_HANDOFF_PY` 为大工作区内存能力。夹具与局部加速不能证明真实 AI 项目整体快四倍。

5.8 / 插件 2.7：强规划 AI 可以直接实现简单需求，plan.json 使用 deliveryMode=direct、deliverables=[实际成果文件]、stages=[]。对应文件必须在已经保存的规划快照中、路径有效且非空，不能只写计划；仍经过模型/深度回执与对象存储屏障，不新增实现或验收调用。委派模式继续支持 1 至 10 个阶段。自动模式下可为阶段填写 modelPolicy={model,effort,complexity}，目录提供各入口已验证模型和支持深度；按分工而非整个项目选择，手动模式、显式模型/深度优先，DeepSeek 始终锁定。文件冲突仍可提升自动模型，规划提示不携带凭据。读 run.adaptivePlan.directDelivery 与实际文件判断直接交付，不假设每次运行都有实现子节点。

## GitHub 闭环优先（5.9 / 插件 2.8）

用户已授权当前开发任务自动建开发分支、提交代码、运行 CI、生成 PR；测试通过后由 Codex 检查并批准合并，不重复询问已授权的合并。只处理当前任务的 PR，不自动合并无关 PR。当前自有仓库 napoleonhalvorson1-design/dsh-gpt 的 PR #1 已真实完成闭环，证据见 docs/github-delivery-live.json；CI 覆盖接入模块与合并门槛，不能替代未来业务功能测试。

先用现成 Codex GitHub 连接；网站后台没有 PAT 时不把它当作阻塞聊天操作，也不声称后台已有 GitHub 授权。原有 github 适配器新增 repo/branch/create_branch/commit_files/pull_request/create_pull_request/workflow_runs/dispatch_workflow/ci_status/merge_pull_request；操作 schema 由 engine connection/types 返回。新提交操作禁止直接写默认主分支，基于 expectedHeadSha 原子更新文件树，保留未修改文件。合并前读取当前 head 的完整 CI 分页；空、失败、等待、缺失必要检查均不通过。Codex 单独批准 approvedHeadSha，并带 expectedHeadSha 调 GitHub，head 改变即失效；merge_pull_request 禁止保存或执行为自动 pipeline 步骤。不得使用自动 auto-merge 代替 Codex 批准。后台密钥与模型密钥不下发 AI。

5.10 / 插件 2.9：新自托管项目可设置 repository、branch、githubConnectionId（默认 github-public）。快捷 preset 与 develop create 保留这些字段。仓库在任何推理前固定为 SHA，归档只下载一次并经校验入桶，所有分支共用同一基线；独立根分支汇合也使用源仓库基线，保留删除语义。run.repositorySource 为真实源记录；_canvas_repository_source 为保留的内部快照标识。私有读取需要后台 GitHub 连接 Contents 读权限，聊天凭据不转移。源代码不向 Agent 分发 GitHub 密钥，归档跳转只接受同源或 GitHub codeload，跳转不带认证 Header。存储失败重试不移动源提交，重启优先恢复桶快照。

归档保留脚本执行位（规范化为 644/755，原生隔离目录写为 600/700），整包回执也检查执行位。helper 以内容哈希命名，保留旧 helper 供冻结的旧运行使用；升级通过 ops/install-fast-handoff.mjs，保持原配置权限和账户。GitHub commit_files 的 mode 可为 100644/100755；修改脚本保留原执行位。执行分支直接实现职责，新增协作由本次 plan.json 交给引擎派发，避免在导入源码的 AGENTS 指南中再次启动工作流。

5.11：用 `canvas runs performance --id ID` 或 `canvas_run_status` 的 view=performance 读取无模型输出的耗时摘要，历史缺失值为 null。真实对比使用 `scripts/benchmark-real-development.mjs`，必须显式 --allow-real-models；它调用实际模型和桶，不能用于常规升级检查。固定需求、源版本与模型目录，记录失败和恢复；单次成功不能证明整体快 11 倍。S3 文件上传只对临时错误用新流重试一次；阶段归档和清单的独立成功回执跨重启保留，两个都成功才交付。

5.12：规划只写文件职责与必要接口，完整任务由引擎附带。server/execution-history.mjs 汇总最近 50 个运行中已入桶、已确认模型的成功阶段，以及单列的失败次数和已确认停止前等待；停止未交付不混入成功样本。耗时包括模型启动和工具，任务不同，不能宣称模型能力排名。ACP 标准 prompt-result usage 保存为 runtime-usage.json，只含数字用量；缺失保持 null，无效遥测不阻断交付。输入快照也保存独立成功回执并用新流重试。ops/install-execution-policy.mjs 在三个服务校验新脚本后原子更新受保护 profiles.json 的 policyRuntimePath（内容哈希路径），保留属主、组、权限和旧脚本；不改登录，不调用模型。

5.13 / 插件 2.12：阶段可设置 executionPolicy={budgetSeconds,fallbackProfile?,fallbackModelPolicy?}，30–7200 秒，原会话两次确认停止后最多切换一次已验证备用，先确认原输入入桶，新请求及冻结配置事务保存，使用同上游的新目录。原会话恰好完成优先交付，用户取消不切换，输出保存失败不重新推理。strongest 规划默认 300 秒及同模型同深度跨入口后备，三个匹配成功观测可延长至最多 900 秒，显式节点策略优先。历史运行不变。耗时包含旧尝试，停止等待单列。见 docs/execution-budget.md；新测试不调用真实 AI。

5.14 / 插件 2.13：AI 可按阶段设置 runtimeContext=focused/inherit，只在 profiles 声明支持时使用。纯代码阶段 focused 限本次 Codex ACP 子进程的 App/插件和技能目录；需要外部服务或相关技能则 inherit，不确定时继承。项目显式设置优先，默认及历史会话不变。三服务器配置探针不创建 thread、不发 prompt，确认后才开启入口能力；禁止更改用户账号、凭据或托管要求。续跑冻结模式与哈希策略路径，runtimeContextRequested 不是实际行为或速度证明。见 docs/runtime-context.md。

5.15 / 插件 2.14：Storage.sync 将独立项目与运行作为有界并发根，空闲 16、有开发运行 4；根内版本/指针、日志块/索引和产物/清单保留先后顺序。历史根失败不阻断其他根、连接配置与备份，lastSync 仅整轮成功更新，lastSyncBatch 只给计数及最多 20 个 kind/id，不返回原始错误/凭据。关闭中止排队及本进程网络等待，等同步结束再关数据库；不声称撤销远端写入。shared/settled-pool.mjs 由真实引擎开发任务交付，经公共产物契约及签名 S3 协议测试后接入。局部夹具速度与实际开发速度分别报告。

5.16 / 插件 2.15：新 strongest 规划按工作台保留量分散到同引擎、同模型、同深度的已验证入口；manual 不改，平局保留原入口，不降级，显式备用与上下文约束继续有效。迁移不缩短原已学习预算。modelSelection.placement 仅是派发选择，不是实际模型回执。既有请求和已开始阶段不改派，续跑回到原规划入口，使用当前同入口凭据和冻结策略路径；地址变化仍拒绝。只读预览不建立保留。执行分支仅完成本次隔离职责，协作交给 plan.json；工作台操作者才使用接入/运行管理流程。见 docs/planner-placement.md。

5.17 / 插件 2.16：新运行可指定 baseRunId（CLI --base-run）在同项目已成功且入桶的成果上继续开发，保留代码、测试、二进制、执行位及删除语义，不重跑原 AI。来源固定为校验快照，新基线也须入桶后才启动新推理；存储失败/重启只补存储。baseRunId 优先于仓库导入，repository 仍用于 GitHub 交付。未完成任务使用 resume。说明见 docs/incremental-development.md；协议测试不代表整体已达 11 倍。

5.18 / 插件 2.17：Storage.sync 的独立项目/运行/配置/到期备份共享一个有界队列，活动运行先拿槽，不再有整类等待。lastSyncBatch 实时提供 total/active/pending/completed 与逐项完成结果；版本/latest、日志块/index 等根内顺序及关闭排空保留。settledPool 新增可等待 onSettled，通知失败停止新派发并排空后以原错误拒绝，不重试 worker。实测证据见 docs/performance-sync-5.18.0.json，未证明整体 11 倍。

5.19 / 插件 2.18：单次 start 可覆盖模式、深度和 taskComplexity（CLI --complexity）；快捷创建保留难度。planningComplexity/--planning-complexity 是 auto+strongest 负责人的初始难度提示，仅在用户未固定全程难度时生效，不限制负责人后续阶段升级；评估实际语义而非说明长度，不确定用 auto。单次参数不保存项目，续跑保持冻结设置，DeepSeek Flash/max 不变。见 docs/run-policy.md；真实任务证据在 docs/performance-policy-5.19.0.json，未证明整体 11 倍。

5.20 / 插件 2.19：DeepSeek DSH v4 可用 runs trace 或 canvas_run_status view=trace/nodeId 做只读数字诊断；需受保护 profile.nativeTrace 的目录配置及原生 python3/zstd。验证本次回执、唯一原生会话与工作目录，只返回计数和时间；不传模型/思考/工具文本，不改运行状态。用量与工具区间均为已知下限，取消不算成功。最近同入口已验证模型的摘要可供最强负责人分工参考，重启后可重读。Flash/max 不变。见 docs/native-trace.md。

5.21 / 插件 2.20：maxParallelNodes 只计本运行的准备/推理阶段，模型完成后保存快照的阶段不占推理名额；真正依赖继续等待已校验入桶的 outputReady。全局准备/推理仍最多 5，DAG 常驻调度最多 10、未结束阶段工作最多 10，保存积压会阻止新阶段继续派发。历史串行运行仍最多 3，与 DAG 共享全局执行名额。恢复查询不会让旧排队记录遮住已提交会话或另一类队列；activeNodeIds 仍包含正在保存的阶段。见 docs/scheduler-capacity.md，不把夹具吞吐当作真实模型整体 11 倍。

5.22：DAG 与历史串行执行器以单个 SQLite 事务保存一页原生事件及对应节点输出/读取位置，网络请求在事务外。提交前退出重读整页，提交后退出输出与位置均可恢复。保留 FULL 持久化、事件去重、脱敏和最新兄弟节点合并。scripts/test-event-checkpoint.mjs 覆盖真实子进程退出及 WAL 恢复。配套插件 2.20 保持兼容。原生 events POST 没有客户端幂等 ID；不为尝试同会话修正而盲目重发不确定消息。

5.23：shared/planner-context.mjs 用矩阵保留已验证能力与数字观测，模型/深度定义去重，去掉无关标签及地址等字段。planningInstructions 保留强负责人、手动优先、DeepSeek Flash/max 和原有 DAG/预算规则；不再预设长代码应交给某个入口。协作规则与能力数据放在任务文字前，用户任务原文和面向用户的字段继续使用用户语言。旧手动入口仍可按默认路由使用，不将其未验证模型作为自动候选。字符减少不等于实际 token 或整体耗时同比减少。

5.24 / 插件 2.21：新 strongest 运行冻结 planRepairVersion=1；已校验且入桶的规划结果不合法时，同一已验证负责人按具体错误最多自动修正一次，原预算至少剩 30 秒。修正使用新请求和隔离目录，保留代码/二进制/执行位，输入与输出按 repair-N 分别保存，原回执不带入新会话。存储故障不触发修正，成功模型不因存储重跑；取消和重启都遵守预留请求身份。再次不合法等待明确继续，旧运行无自动新增推理。创建响应不确定且会话暂时 404 时复用原请求 ID，不擅自换 ID。实际无效计划次数、全部尝试与等待保留，不能从局部恢复推导整体 11 倍。见 docs/plan-repair.md。
