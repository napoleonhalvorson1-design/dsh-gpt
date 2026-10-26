# 接入引擎

同一工作台、账户绑定、数据库和七彩云桶。版本：插件 2.0 / 网站 5.0。

## 发现与配置

1. `canvas_engine_types` 列出支持类型；`canvas_engine_connections` 列出真实连接及操作。
2. `canvas_engine_connection` 返回可调用操作、inputSchema、只读策略与 revision；不返回密钥。
3. 新连接 `canvas_engine_save_connection` 的 expectedRevision=0，修改使用最新 revision。definition 含 type、label、enabled、readOnly、config，按需 openApi。配置默认只读。允许 AI 推理或写入需 readOnly=false。
4. 凭据在网站「接入引擎 → 配置」填写，或使用 secrets 字段中的环境变量引用，例如 `{"token":{"env":"CANVAS_ENGINE_GITHUB_TOKEN"}}`。不在聊天、项目提示词、命令参数或插件里写真实密钥。环境变量由控制器服务读取，不是聊天进程的临时环境。默认仅允许 CANVAS_ENGINE_ 前缀的外部凭据；其他变量需由控制器 CANVAS_ENGINE_ALLOWED_ENV 显式允许，服务内部密钥禁止引用。
5. `canvas_engine_test_connection` 为只读测试。Agent 检查仅证明执行入口已配置，不代表模型执行成功。真实账号需要有效授权后才可报已连接。

类型及常用操作：

| 类型 | 操作 |
| --- | --- |
| agent（内置五 AI） | test、run（input.task） |
| canvas-storage（primary-bucket） | list、read、put |
| openai / anthropic | models、chat（prompt、model、system） |
| s3 | list、read、put |
| github | repos、contents、issues、create_issue、put_file |
| webdav | list、read、put、mkdir |
| google-drive | list、read、create、update |
| onedrive | list、read、put |
| http | 自定义操作或 OpenAPI 3 JSON 导入 |

GitHub 连接的 authorization 显示凭据是否配置及写入是否准备好；readOnly=false 不代表已有授权，缺凭据时写操作 available=false。连接可配置 owner 限定自有仓库；未认证只能列举该 owner 的公开仓库，认证测试读取 /user，公开 rate_limit 成功不算账号已连接。Codex 已连接的 GitHub App 可在聊天中直接操作，但不会自动把凭据转给后台。GitHub 后台使用 Fine-grained PAT 的实际仓库权限；网盘使用用户管理的 Access Token 或 WebDAV 账号。Google Drive/OneDrive 的 Token 过期需在原连接更新或由服务器环境变量管理；引擎不假冒网页登录或已经授权。分页遵循各接口返回的 nextCursor、nextPageToken、@odata.nextLink；OneDrive 将原 nextLink 传给 cursor。

S3 配置：baseUrl、bucket、region、prefix、forcePathStyle，secrets 使用 accessKeyId、secretAccessKey，可选 sessionToken。使用 s3v4。内置工作台桶默认只读；用户明确允许写入后，仅允许 put 到相对键 `engine-data/` 下，保护已有项目和备份。

HTTP 配置：baseUrl、auth（none/bearer/basic/apiKey）、operations；apiKey 填 header，可选 prefix。所有操作相对 Base URL。operation 需要 id、method、path，可选 query、headers、body、bodyType（json/text）、inputSchema。使用 `{{input.field}}` 绑定输入；路径参数自动编码。JSON 整值引用保留原类型。认证 Header 只能在连接 auth 中配置。公网 HTTPS；自建服务明确开启 allowPrivate，元数据服务仍禁止。响应/请求限制 2 MiB，普通调用默认 30 秒，可配置最长 120 秒。不跟随带认证的重定向。

OpenAPI 3 JSON 支持普通 object/array/string/number/integer/boolean 参数、path/query/header 和 JSON body。先展开 $ref/组合 Schema，不支持独立操作级服务器、回调、流式响应和任意可执行代码。非 HTTP 协议可通过用户的 HTTP 网关接入，或在源码的适配器模块扩展。

## 调用与流程

`canvas_engine_invoke({id,connectionId,operation,input})` 返回后台任务。轮询 `canvas_engine_job({id})`，succeeded 后读取 result。`canvas_engine_history` 分页列举调用，不返回输入/输出全文。唯一 ID 的相同提交不会再次调用外部接口；同 ID 不同参数返回冲突。failed/interrupted 先核对外部状态，再依用户要求发起新的操作。

多步骤流程保存示例：

```json
{
  "id": "repo-ai-drive",
  "label": "GitHub → AI → 网盘",
  "expectedRevision": 0,
  "steps": [
    {"id":"source","connectionId":"my-github","operation":"contents","input":{"owner":"{{input.owner}}","repo":"{{input.repo}}","path":"README.md"}},
    {"id":"ai","connectionId":"my-model","operation":"chat","input":{"prompt":"总结这个项目：{{steps.source.data.text}}"}},
    {"id":"save","connectionId":"my-webdav","operation":"put","input":{"path":"summary.txt","content":"{{steps.ai.data.choices.0.message.content}}"}}
  ]
}
```

先确认这三个连接真实存在且具备所需权限，再保存。用户要求运行时用唯一 id 和 pipelineId 调用 `canvas_engine_run_pipeline`，input 提供 owner/repo。保存或修改流程不自动调用外部服务。

现有五 AI 内置连接分别是 `ai-deepseek-shanghai`、`ai-codex-shanghai`、`ai-codex-silicon`、`ai-codex-seoul`、`ai-claude-silicon`。run 操作创建可跟踪的工作台项目/运行，结果包含 runId、projectId、output，文件仍使用原有 canvas_list_files / canvas_read_file。不要将 API 模型和有文件工作目录的 Agent 当作同一能力。

## 升级和备份

`canvas engine export` 导出无密钥的连接和流程。连接配置、操作结果加密保存在 SQLite；引擎配置与调用记录同步到已有桶的 `openhands-canvas/engine/`，数据库备份保留加密凭据。恢复完整凭据需要原加密主密钥；不要把主密钥放进桶。

适配器源码为 server/connector-adapters.mjs，注册目录为 server/connector-catalog.mjs，持久化与流程为 server/connectors.mjs。网站、MCP 和 CLI 共用 /engine API；扩展适配器同时增加协议验收，不能只增加类型名称。
