# GitHub 开发闭环

用户主要通过 Codex 聊天操作。当前授权仓库 `napoleonhalvorson1-design/dsh-gpt` 已接入，主分支 `main`，开发前缀 `codex/`，必要检查 `canvas-ci`。首个真实闭环为 PR #1，分支、提交、push/PR 两轮 CI 及批准合并已完成；这证明接入和合并门槛，不代表未来业务功能已经测试。

1. 读仓库、默认分支和当前 SHA，读取目标文件。为当前需求建立唯一开发分支；不要覆盖其他任务的分支。
2. 启动自托管任务前把项目的 repository、branch、githubConnectionId 设置为本次仓库、开发分支和后台读取连接。引擎将仓库固定在源 SHA，一次下载后共享给所有分支；在 run.repositorySource 核实真实导入状态。公开仓库可匿名读取，私有读取仍需独立后台凭据。旧运行不覆盖工作目录。
3. 五 AI 在隔离目录中按需求实现，Codex 将实际交付文件和必要测试提交到开发分支。多文件用 tree/commit/ref 原子更新，基于已读取 head，禁止 force 覆盖。保留用户未改动文件，不提交凭据或运行数据库。
4. 推送触发已有 CI。没有工作流时为当前项目添加合适的工作流；不能以“没有检查”声称通过。创建 PR，描述实际实现及测试范围。初始化接入的 CI 只验证接入模块，后续应用必须增加自己的功能测试。
5. 查询当前 PR head SHA 对应全部检查、Actions 和 commit statuses，处理分页；读取失败或不完整不能合并。等待明确成功，失败先按日志定点修复再等待新 SHA 的 CI。不反复启动新的 AI 全面审查。
6. Codex 检查具体改动、必要检查及目标分支后，单独批准该 SHA，再调用原生 merge 工具并设置 `expected_head_sha`。不要预先开启 auto-merge，不能将批准写为固定流水线步骤。GitHub 分支保护、外部审查要求仍须满足；自己创建的 PR 不使用 GitHub 正式 APPROVE 自己。
7. 回读 merged、merge commit SHA 和链接，简短交付；未合并须说明实际状态。连接断开或写结果不确定时先查询，不能重复建分支/PR或盲目重放。

## 网站后台 API

先读 `canvas_engine_connection`（通常 `github-public`）及 authorization。`credentialConfigured/writeReady=false` 时使用 Codex 原生 GitHub，不能把聊天连接转为后台 PAT。

后台配置好独立凭据后，原有 `canvas_engine_invoke` 支持以下 GitHub 操作，不新增 MCP 服务器：

| 操作 | 主要参数 |
| --- | --- |
| repo / branch | owner、repo；branch 还需 branch |
| create_branch | owner、repo、branch，可选 base |
| commit_files | owner、repo、branch、expectedHeadSha、message、files |
| create_pull_request | owner、repo、head、title，可选 base/body/draft |
| pull_request / ci_status | owner、repo、number；ci_status 可传 expectedHeadSha |
| workflow_runs | owner、repo、headSha，可选 page |
| dispatch_workflow | owner、repo、workflow、ref，可选 inputs |
| merge_pull_request | owner、repo、number、expectedHeadSha、approvedHeadSha，可选 method/title/message |

files 为 1–100 项 `{path,content,encoding?,mode?}`；mode 为 100644 或 100755，修改已有脚本应保留执行位，encoding 为 utf-8 或 base64；删除用 `{path,delete:true}`。调用总请求限制 2 MiB，较大交付通过 Codex 分批提交，不截断文件。commit_files 禁止直接写默认主分支，校验分支 head 后原子提交；合并前引擎重新查询完整 CI，并把确切 SHA 交给 GitHub。连接 config.baseBranch 可固定 main，config.requiredChecks 可列必要检查。后台细粒度令牌按操作需要 Contents、Pull requests 读写，Actions 读（手动 dispatch 需写）、Checks 读；修改工作流还需对应 Workflows 写权限，密钥在网站或环境配置，不能发到聊天。

唯一调用 ID 去重，`canvas_engine_job` 跟踪；新提交后重新查询并批准。merge_pull_request 只允许单独调用，不能保存或执行为自动 pipeline 步骤。操作与回执沿用数据库加密和七彩云同步。
