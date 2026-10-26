---
name: openhands-collaboration
description: "通过 OpenHands 接入引擎连接 AI、S3、GitHub、WebDAV、Google Drive、OneDrive 或通用 HTTP/OpenAPI 接口，编排跨服务流程；也支持原有五 AI 项目、任务和七彩云数据桶。用于工作台操作者在 Codex 聊天中管理项目、运行、服务接入、跨服务编排或维护配套插件。已获引擎分配的隔离目录和具体职责的纯代码/文档执行分支不适用。"
---

# OpenHands 五 AI 协作

本技能面向工作台操作者。消息已分配隔离工作目录、输入及具体开发职责时，按执行分支完成本地代码与文档；协作通过本次 plan.json 交给引擎派发。操作工作台服务的明确需求再使用以下项目、接入与运行流程。

用户主要通过 Codex 聊天操作服务，手机用于查看进度、预览和下载，以及少量说明修改。直接完成用户要求的工作，不要求用户手动编辑画布，不重复询问已授权的操作。

## 接入引擎

用户要求接入 AI、GitHub、数据桶、网盘或其他 API，或要求跨服务编排时，先读 [引擎操作说明](references/integration-engine.md)。使用 `canvas_engine_connections` 和 `canvas_engine_types` 查看实际目录，不能把支持的类型当成已授权连接。原有五 AI Agent 和七彩云桶为内置连接。通过只读操作测试，不为接入验收调用模型、创建 Issue 或写文件。

通用调用需要唯一请求 ID，用 `canvas_engine_invoke` 提交，用 `canvas_engine_job` 跟踪。多步骤流程用 `canvas_engine_save_pipeline` 保存，再按用户要求 `canvas_engine_run_pipeline` 执行；保存不执行。外部写操作和 AI 推理遵循用户当前任务授权。重启后 interrupted 表示外部操作可能完成，应先核对，不能自动创建新 ID 重放。密钥通过网站或服务器环境变量提供，不向用户索要聊天中的明文密钥。

GitHub：Codex 的已连接 GitHub 可直接读写其授权仓库，优先使用现成 GitHub 工具；它与网站后台的 PAT 凭据相互独立，不得声称已将聊天授权转移到后台。网站连接 readOnly=false 只是配置允许写，须看 authorization.credentialConfigured / writeReady；没有凭据的写操作 available=false，先在网站配置。用户已授权操作自己的仓库；写文件前读取当前 SHA，修改使用独立分支及具体任务要求。工具不提供创建仓库时如实说明，可在已有自有仓库的独立分支工作，不把分支称为新仓库。

工具尚未刷新时，使用包内 `scripts/canvas.mjs engine ...` 或服务器 `canvas engine ...`；不能因为 MCP 新工具未出现而重建插件。

## GitHub 开发闭环（第一优先）

用户已授权对自己仓库的当前开发任务自动建立开发分支、提交代码、运行 CI、创建 PR；CI 通过后由 Codex 检查并批准合并，不重复索要合并确认。优先使用当前 Codex 已连接 GitHub；网站后台凭据是独立的，没有 PAT 时继续使用 Codex 原生工具，不宣称后台已授权。具体步骤见 [GitHub 闭环](references/github-delivery.md)。

创建自托管项目时可同时设置 state.repository="owner/repo"、branch 和 githubConnectionId（默认 github-public）。引擎在任何推理前固定并导入源代码提交，多个分支共享基线；run.repositorySource 给出真实 SHA、文件数、哈希与桶快照。私有仓库需要该后台连接的读取授权，Codex 的聊天连接不会自动转移；新功能仅用于新运行，不改写历史工作目录。源代码脚本的执行位通过归档和整包交接保留。

每次开发用独立 codex/ 分支，提交完整实现及必要测试，推送触发现有 CI 并创建 PR。读取当前 head SHA 对应的全部 Actions、check runs 和 commit statuses；没有 CI、未完成或失败都不能当作通过。确认实际改动和必要检查通过后，由 Codex 单独批准当前 SHA，再带 expected_head_sha 合并。新提交使旧批准失效；不将 merge 操作预先放入自动流程，不自动合并其他任务的 PR。自己的账号不能在 GitHub 正式批准自己创建的 PR；这里的批准为 Codex 的独立合并决定，仓库若要求外部审查仍遵守 GitHub 规则。

## 连接与检查

优先使用本插件提供的 `canvas_*` 工具，工具名可能带服务前缀。先调用 `canvas_list_projects`；需要查看存储时调用 `canvas_storage_status`。只读取状态、介绍用法、打包或升级时，不启动模型任务。

如提示未绑定账户，使用工作台设置「通过 Codex 操作」的一次性连接码调用 `canvas_connect`。不要求用户发送 SSH 密码、模型登录信息、S3 密钥或服务令牌。不要创建同名插件、改写 App ID，或把同一服务重复添加为 MCP 服务器。

若主机当前尚未刷新某个新工具，优先使用已有的等价工具。具备本地执行和已配置访问令牌时，也可使用插件内的 `scripts/canvas.mjs` 或服务器的 `canvas` 命令；凭据从环境变量或私有配置读取，不能放在命令参数里。网页与插件共用同一项目和运行记录。

## 按需求自主协作（2.7）

用户要求多干活、少审查，节省 token。AI 根据需求自己决定怎么合作，优先实现功能，规划、交接和回复都简短。新建项目优先 `canvas_save_project({id,expectedRevision:0,state:{preset:"five-ai",title,task}})`；CLI 对应 `canvas develop create`。保存不执行；用户要求实际开发时继续使用唯一 run ID 调用 canvas_start_run。

1. 查询 canvas_list_profiles 了解实际入口和已验证能力，读取 [自主协作种子](references/five-ai-workflow.json)。默认 collaborationMode=adaptive、plannerPolicy=strongest，初始仅 start→plan→end；不要按固定八阶段或固定前端/后端/测试/审查四路编排。
2. 分工由已验证的最强可用模型负责，当前优先 GPT-6 Astra（硅谷 Codex，其他已验证入口可回退），不再固定由 DeepSeek 规划；开发仍由规划 AI 按需求分给团队，DeepSeek 执行时保持 V4.1 Flash + max。规划 AI 按需求决定任务、人数、角色、入口、依赖和并行方式，只需写 .canvas-collaboration/plan.json；确有共享接口需要时再写说明。允许简单需求少用 AI；无关职责不为凑齐五个入口而添加。规划 AI 可直接实现简单需求，plan.json 写 deliveryMode="direct"、deliverables=["实际成果文件"]、stages=[]；文件必须在已校验的规划快照中且非空，不能只有计划。此时只有一个 plan 节点即可成功，不再强制第二次实现调用。DeepSeek 始终 V4.1 Flash + max。
3. 自动模式下，规划 AI 能读取各入口已验证模型与深度，为各分工设置 modelPolicy={model,effort,complexity}，按分工难度分别选择。用户指定的模式、模型和深度优先；DeepSeek 的选择仍被强制为 V4.1 Flash + max。不能仅凭计划宣称实际模型已生效，仍查看 selectionApplied 和快照内对应会话回执。
4. 引擎读取已入桶的规划快照，校验计划后扩展本次运行，阶段 phase 为 build / integrate / verify / deliver；独立任务并行，真实依赖等待上游文件。默认 coordinationPolicy=lean：1 个 build 即可交付，verify/deliver 可省略、合计最多一个；只有必要才另开检查节点，verify 等全部 build/integrate 完成。主要投入实际实现，最后做与改动直接相关的小检查一次，有失败再定点修复。
5. 用 canvas_run_status 的 adaptivePlan、order、nodes 跟踪 AI 实际分工；adaptivePlan.decisions 是分工理由，applied 代表计划已通过并落库，不代表代码已完成。初始只有规划节点是正常状态；adaptivePlan.directDelivery=true 且 run.status=succeeded 代表负责人已直接完成，读取 deliverables 和真实文件确认交付。模型预览在规划前只显示规划入口，其他阶段运行时生成。
6. 实干节点可检查后直接交付，独立分支可由引擎自动汇合，不为验收另叫 AI。不强制生成 PLAN/CONTRACT/TEST/REVIEW 报告，不例行安排风险审查或重复复核。已有运行说明确需变更再更新，最终简短说明实际成果、文件与必要检查结果。

现有项目先读 state/revision。用户明确要求把固定项目改为自主协作时，保留 title/task、仓库及运行设置，替换种子的 nodes/edges，并设置 collaborationMode=adaptive；用当前 revision 保存。不能自动覆盖运行或历史。既有固定工作流仍能执行，用户明确指定的流程以用户为准。

无效计划不会启动开发分支。5.24 起，新 strongest 运行在原预算允许时，由同一已验证负责人保留成果、按具体错误最多自动修正一次；再次不合法等待明确继续。旧运行不自动增加推理，明确继续时沿用已有成果修正。有效计划及生成的配置用同一事务保存，控制器重启不重复扩展，已成功开发阶段的快照重试不重新调用 AI。五 AI 是可用团队，人数和任务数量由需求决定。

分支目录隔离，跨服务器文件通过桶快照及 SHA-256 校验交接。同文件冲突保留每版与显式解决记录；集成 AI 写 resolutions.json 的 source/reason/sha256，校验后解锁下游。单运行及全局最多五个节点并行。停止等待所有实际启动的分支确认；续跑保留成功产物。账号配置和凭据保留在服务器，不把 S3 密钥发给 AI。

## 模型与思考模式（2.3）

五 AI 新项目默认 `modelMode="auto"`、`reasoningEffort="auto"`。支持 auto（自动）、fast（速度）、balanced（均衡）、deep（深度）、manual（手动）；按用户“快一点 / 深入分析”等要求直接调整。先读取项目与 revision，修改完整 state 的 modelMode、reasoningEffort、taskComplexity（auto/simple/standard/complex），再用 canvas_save_project 保存，保留所有节点和连线。保存不启动任务，续跑保留原运行选择，新运行应用新设置。

DeepSeek 在任何模式及手动覆盖下均固定 **DeepSeek V4.1 Flash + max**（用户所说“4.1fmax”），原生 ID 为 `["deepseek-official","deepseek-flash"]`；不得换 Pro 或降低深度。其他模型自动选择仅使用 canvas_list_profiles 返回的 verified=true 项；任务难度、集成/审查/验收阶段及文件冲突会影响模型与深度。支持深度以每个入口的 models[].efforts 为准，不假设所有账号相同。Fable 仅手动指定，自动模式不选。

各节点可设置 liveModel（来自当前入口 models[].id）和 reasoningEffort（auto/low/medium/high/xhigh/max）。清空 liveModel 跟随模式。先做无推理预览：`canvas models preview --project ID --mode fast`；保存用 `canvas models set --project ID --mode auto --effort auto`。只覆盖一次新运行用 `canvas runs start --project ID --id UNIQUE_ID --mode deep`。CLI 支持 --complexity；HTTP 预览为 POST /api/model-policy/preview，body={workflow:完整state}，只读权限即可。

运行节点 modelSelection 表示计划选择，selectionApplied/reasoningEffortUsed 表示原生会话确认生效；不得把计划当成实际执行。后端在启动会话时设置模型和深度，未确认则阻止推理，阶段快照验证对应会话的回执后才解锁下游。不要更改服务器全局账号配置。模型目录存在但实际小任务失败时，排除自动选择并如实反馈，不能凭列表宣称可用。

## 修改、停止和继续

只改名称或任务说明：先读项目，用 `canvas_update_project_details` 及当前 revision；工具未刷新时，读取现有 state，只替换 title/task，再用 `canvas_save_project`，保留节点、AI 入口、提示词与连线。保存说明不触发执行。

调整流程：读取现有项目并使用版本校验保存。更改已在运行的项目不会改写本次运行的输入快照；需要执行新需求时创建新的运行。

停止：调用 `canvas_stop_run`，等待 `cancelled` 才说明后端已确认停止。继续：调用 `canvas_resume_run`，从未完成处恢复。对象存储失败时，已成功的 AI 阶段不能重复执行来代替重试文件保存。

## 文件交付与直达链接

项目直达：`https://canvas.43-173-109-57.sslip.io/?project=项目ID&run=运行ID`。登录后保留所选项目和历史运行。完成后给用户直达链接、主要交付文件和实际验证结果。

文件列表包含 partial/sourceStage 时，表示最新已完成阶段的快照，不代表整个项目通过验收。失败或运行中仍可读取阶段文件诊断，不能把阶段快照写成最终完成。完整交付由 run.status=succeeded 及实际文件证明。单个文件下载为工作台 `/api/runs/运行ID/file-download?path=相对路径`，下载需要登录。

静态网页预览会加载本地 JS、CSS 和图片，localStorage 按运行与入口文件隔离保存。页面仍在无同源权限的沙箱中。需要构建、后端、复杂模块导入或服务端数据库的项目，下载后按 README 运行，不能把静态预览当生产部署。

## 数据与手机查看

协作数据位于七彩云 `zzx123-u1aya4fk/openhands-canvas/`。项目版本、任务输入/状态、增量日志、最终产物和每日备份自动保存；新任务每阶段的工作目录快照入桶，每分支输入和汇合报告也入桶，跨服务器交接从桶取回并校验。服务器保留运行目录，S3 密钥只由控制器环境变量提供，不发送给五个 AI，也不打包进插件。

存储检查使用 `canvas_storage_status`、`canvas_list_storage_objects`；列举需处理 nextCursor。不要为只读检查调用写入/删除测试，也不要把对象存储当作可运行程序的文件系统挂载。

[手机工作台](https://canvas.43-173-109-57.sslip.io) 自动显示 Codex 的项目更改和新运行；默认看进度与文件，保留历史运行选择及轻量编辑。不要让用户为了日常任务去手工调整手机画布。

## 升级这个插件或网站

只有用户要求维护或升级时，读取 [配套升级说明](references/maintenance.md)。网站和插件共用既有 Site、App、plugin ID；维护应保留服务器配置、桶数据和账户绑定。插件发行版本与网站版本分别管理，通过配套版本信息检查兼容性。

## 运行耗时（5.11 / 插件 2.10）

用 `canvas runs performance --id ID`，或 `canvas_run_status({id,view:"performance"})` 查看不含提示词和模型输出的耗时数据。未刷新工具 schema 时优先 CLI，普通 status 保持兼容。模型时长区分并行去重墙钟时间与累计工作量；缺失历史时钟返回 null，不当作零秒。节点已完成推理、正在保存快照或写桶时，仍计算等待到当前时间；运行成功仍须通过桶屏障。nonModelWallMs 不是可消除的开销，真实任务的一次对比不能证明整体提速 1000%。

文件入桶遇到网络/限流/服务器临时失败时，用新文件流自动重试一次；拒绝授权不重试。阶段归档与清单各有持久化成功回执，失败后继续不重传已确认的相同部分，不再推理。只有两个对象都确认写入才解锁下游。

## 观测后分工（5.12 / 插件 2.11）

强规划 AI 会收到最近已入桶、已确认模型的阶段耗时和可用 token 用量。任务不同，观测只用于估时，不作为能力排名或速度保证；缺失 token 是 null。完整任务自动传给每个节点，规划职责只写负责文件、差异和接口，减少重复规格。模型、思考深度、人数和并行继续由负责人判断，DeepSeek 仍锁定 Flash/max。

新执行策略回执 .canvas-collaboration/runtime-usage.json 只保存数字用量、请求绑定与时长，不保存提示词或思考内容；node.modelUsage 来自已验证的本阶段快照。无效或不支持的用量不会使有效产物失败。策略脚本按内容哈希安装，旧运行保留原路径，避免升级改写冻结配置。输入快照与输出一样，归档和清单分别保存成功回执，恢复时只补缺失部分，不重复推理。

## 控制尾部等待（5.13 / 插件 2.12）

负责人可为阶段设置 executionPolicy={budgetSeconds:300,fallbackProfile:"入口ID",fallbackModelPolicy:{model:"已验证ID",effort:"支持深度"}}，预算为 30–7200 秒，长任务给足时间。原会话确认停止后最多自动切换一次，从相同上游快照的新目录执行，保留原目录；恰好完成则优先交付原成果，用户取消后不切换。手动选择与 DeepSeek Flash/max 锁优先，所有备用须已验证。

新 strongest 规划默认 300 秒及同模型同深度的跨入口后备，三个匹配规划观测可将预算延长至最多 900 秒；显式节点策略优先。其他阶段由负责人按需求决定。不配置备用时到期确认停止并等待明确继续。budgetRecovery、fallbackCount、attempts 给出实际恢复状态；stopping 不代表已停止。存储失败只重试存储，已完成 AI 不再调用。一次备用耗尽后由明确的继续请求恢复当前暂停会话，不能自动循环换入口。耗时保留旧尝试和全部等待，不能只统计成功备用来声称整体 11 倍。

## 按职责选择上下文（5.14 / 插件 2.13）

先查 profiles 的 executionFeatures.runtimeContextModes。负责人可为纯文件、终端开发阶段写 runtimeContext="focused"；需要 App、插件或相关技能的阶段使用 inherit，不确定时继承，不能为省上下文降低任务能力。只有配置探针确认的 Codex 入口支持 focused；DeepSeek、Claude 继续原环境。项目显式 runtimeContext 优先于 AI 阶段提议，preset 输入也保留它，未设置和历史运行不变。

focused 限该次 Codex ACP 子进程的 App、插件及技能目录，保留模型、思考深度、原生文件/终端、账号和托管要求；需要外部能力时选择 inherit。配置不写入用户全局文件，不重启共享手机 Codex 服务。模式随运行冻结，备用和续跑保留相应配置；runtimeContextRequested 只说明请求设置，不能据此宣称实际模型 token 已下降或整体快 11 倍。

## 并发补同步（5.15 / 插件 2.14）

后台按独立项目与运行并发保存数据，空闲最多 16、有开发运行最多 4；单根失败继续处理其他根。同一任务内部的写入顺序和阶段桶屏障保留。查看 storage_status 的 lastSyncBatch 计数和失败根 kind/id；它不是 S3 请求数，lastSync 只表示完整成功。恢复只补缺失确认，不重跑已完成 AI。操作边界见 [同步说明](references/storage-sync.md)。

## 新规划任务分散（5.16 / 插件 2.15）

strongest 新运行按工作台保留量选择同模型、同深度的已验证入口，手动设置不改，已开始的任务继续原路由。预览只读，实际提交按最新保留量决定；modelSelection.placement 不是实际模型确认。继续时保留原规划入口及冻结策略，配置地址改变须先恢复原地址。保留量不代表服务商队列或账号容量，不能据此宣称整体快 11 倍。见 [规划说明](references/planner-placement.md)。

## 在已有成果上增量开发（5.17 / 插件 2.16）

本项目的新需求可用 canvas_start_run 的 baseRunId 或 CLI --base-run，继承同项目上轮成功且已校验入桶的完整代码与测试，再实现改动；未完成任务仍使用 resume。先读 [增量开发](references/incremental-development.md)，不要重新生成已有项目。run.artifactSource 给出固定来源与新基线哈希，存储失败不重跑旧 AI。

5.18 / 插件 2.17：后台同步的独立根共享统一队列，活动运行优先，lastSyncBatch 实时给出 total/active/pending/completed 与逐项结果计数；busy 且未 finished 不代表整批成功。见 [后台同步](references/storage-sync.md)。

## 初始判断与单次策略（5.19 / 插件 2.18）

未固定模式/深度/难度的新自主任务，由 Codex 按实际改动语义评估 planningComplexity（auto/simple/standard/complex），通过 canvas_start_run 或 CLI --planning-complexity 只提示最强负责人的初始设置。后续阶段仍由负责人独立选择模型、复杂度和深度；不要把初始评估填成全程 taskComplexity，不能仅凭说明字数或为提速把复杂工作降级，不确定用 auto。用户明确固定的设置优先，DeepSeek Flash/max 锁保持。

用户要求单次覆盖时，MCP start 支持 modelMode/reasoningEffort/taskComplexity；CLI start 用 --mode/--effort/--complexity。快捷创建保留两类难度。均不自动修改保存项目或已开始的原生设置；续跑冻结原策略。详细边界和使用见 [运行策略](references/run-policy.md)。新 schema 尚未刷新时用配套 CLI，不重建插件。

## 原生等待诊断（5.20 / 插件 2.19）

DeepSeek 阶段等待较长时，用 canvas_run_status 的 view=trace、nodeId，或 CLI runs trace --id RUN --node NODE 读取已有数字记录，再决定等待、停止或调整下次分工。先读 [原生诊断](references/native-trace.md)。不读取或转述思考内容，不把已知下限当完整账单，不把原生 turnEnded 当交付。最近数字可供最强负责人参考，但失败/取消不算成功样本，不因 token 大就自动停止。Flash/max 锁保持；不为诊断调用模型。


## 推理与保存分别限流（5.21 / 插件 2.20）

独立节点可与已完成模型的快照保存重叠；maxParallelNodes 只限制本运行的准备/推理。全局仍最多 5 个准备/推理节点，另有限制保存积压的阶段总量。真正依赖仍等待 SHA-256 校验与桶屏障，存储重试不重跑 AI。activeNodeIds 含正在保存的阶段，不是实际推理数。见 [调度容量](references/scheduler-capacity.md)。


## 规划的定点修正（5.24 / 插件 2.21）

新运行查看 planRepairVersion；节点 autoPlanRepairCount、planRepair、attempts 给出实际修正与尝试。自动修正使用同一入口、模型和深度的新会话及隔离目录；原始和 repair-N 快照分别保存，不覆盖已有成果。存储失败只补存储，不重跑模型；原预算不足 30 秒或用户取消时不再派发。修正再次失败等待明确继续，不循环调用 AI。创建响应不确定且原生会话暂时 404 时，继续使用原请求 ID 核对，不另建重复任务。详见 [规划修正](references/plan-repair.md)。
