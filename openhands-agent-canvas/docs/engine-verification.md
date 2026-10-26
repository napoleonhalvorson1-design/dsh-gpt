# 接入引擎验收（2026-10-26）

版本：网站/API 5.0.1，既有私有插件 2.0.1，保留原 Site、App、plugin ID。

## 已执行

- `npm run build && npm test`：原有登录、鉴权、后台任务、五 AI 配置、跨服务器交接、S3 持久化全部通过；新增引擎协议验收通过。
- `node scripts/test-engine.mjs`：62 项检查，覆盖 HTTP/OpenAPI、两种 AI API、S3 Signature V4、GitHub、WebDAV、Google Drive、OneDrive、多步骤结果引用、加密、权限、分页、幂等、重启，以及阻止引用内部/未授权环境变量。
- `node scripts/test-engine-hosts.mjs`：实际 Worker/MCP → 控制器、独立 CLI 子进程、共享调用记录、桶快照、S3 相对键约定。
- `node scripts/test-engine-agents.mjs`：引擎连接 → 原工作流队列 → 隔离 Agent Server 协议端 → 关联运行与输出；重复提交只调用一次。
- `npm run test:mobile`：原有手机项目查看、编辑冲突、历史、文件预览通过。
- `npm run test:engine-mobile`：390px 添加/测试/调用连接，保存/执行流程与结果查看，320px 无横向溢出，1440px 双列，零页面错误。
- 上述适配器和浏览器测试使用隔离协议服务，不使用真实模型、不写真实 GitHub/网盘。

## 真实线上只读验收

- 升级前活动 AI 任务为 0；一致性数据库和代码备份位于硅谷服务器 `/opt/openhands-control/releases/pre-engine-2026-10-26T12-46-49-318Z/`，未复制凭据环境文件。
- 原有 7 个项目仍存在；控制器、网页、原生执行端服务正常。
- 新引擎发现 10 种连接器；5 个原有 AI Agent 和七彩云桶自动纳入连接目录。
- 新建只读 `github-public`，真实读取 OpenHands/OpenHands 的 README.md，返回 13258 字符。未连接用户的 GitHub 私有账号。
- `primary-bucket` 真实 S3 列举成功。`openhands-canvas/engine/latest.json`、版本文件、调用记录已实际存在于七彩云桶；读取这些对象仍使用原服务器环境变量。
- 模型入口测试只确认既有配置；未启动真实 AI 任务。既有五 AI 的历史真实验收继续保留。

## 使用条件

私有 GitHub、其他桶、网盘、模型 API 需由用户在密码保护的网站配置凭据或服务器环境引用。Google Drive/OneDrive Access Token 的获取与续期由原账号授权流程管理。支持常用 HTTP(S)/REST/OpenAPI 3，非 HTTP 协议通过 HTTP 网关或源码适配器扩展；没有声称支持所有协议或代替第三方授权。
