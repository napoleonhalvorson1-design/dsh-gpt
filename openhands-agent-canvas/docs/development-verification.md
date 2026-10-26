# 五 AI 项目开发实战验收

2026-10-26；工作台 5.1.1，配套私有插件 2.1.1。

## 实际交付

项目：[五 AI 实战 · 项目需求看板](https://canvas.43-173-109-57.sslip.io/?project=d3445473-377f-4a2c-8759-9bfa4f56b5c1&run=78bb2407-1f32-4d1d-b3a1-86fb934e36d9)（需要工作台登录）。

- projectId：d3445473-377f-4a2c-8759-9bfa4f56b5c1
- runId：78bb2407-1f32-4d1d-b3a1-86fb934e36d9
- 实际五阶段全部 succeeded：上海 DeepSeek 规划、上海 Codex 方案、硅谷 Codex 开发、首尔 Codex 测试修复、硅谷 Claude 审查。
- 实际生成 13 个文件，包括 index.html、board-core.mjs、README.md、TEST.mjs、PLAN.md、DESIGN.md、TEST.md、REVIEW.md 和分阶段材料。
- 下载的最终 tar.gz SHA-256：fc367ec72c656cb4516a3138c2ec08dfb8cf7c1e9d4e906b3a81e67c7a8e4b44。
- 七彩云桶该运行目录实际列举到 25 个对象，含输入、状态、增量日志、五个阶段的工作目录与 manifest、完整产物。

该项目是一次真实模型协作开发，不是写死的前端状态或模拟输出。模型文件经过独立读取、下载和操作验证。

## 实际执行的检查

- `npm run build && npm test`：登录/权限、真实后台协议、恢复/停止、五 AI 入口与交接、S3、接入引擎，以及标准五 AI 项目创建均通过。
- `node scripts/test-development.mjs`：新增项目幂等与冲突、缺失 AI 配置、权限、MCP 代理、二进制附件下载与路径保护、等待输入任务停止。创建不执行模型。
- `npm run test:mobile`：默认五 AI 创建、需求保存不执行、手机查看/微调、冲突保护、外部更新、历史运行固定、登录后项目直达、320px/390px/桌面布局。
- `npm run test:engine-mobile`：原有接入引擎配置、测试、流程和结果继续正常。
- `npm run test:preview`：本地 JS/CSS/图片内联、预览保存、运行间隔离、无同源权限、不能访问父页面。
- `CANVAS_ARTIFACT_DIR=/tmp/openhands-usable-final npm run test:real-development`：对上面真实五 AI 产物进行完整浏览器操作；新增、编辑、删除、状态切换、关键词/状态筛选、统计、恶意 HTML 文本不执行、重开仍保存、JSON 下载、非法导入保护、合法导入与空看板保存、320px/390px/1440px 均通过，零页面错误。
- 对真实下载目录独立执行 `node --test TEST.mjs`：48/48 通过；未将模型报告作为替代证据。

浏览器回归使用本机 HTTPS 服务和真实浏览器登录重定向、Cookie、iframe，不靠对假域名的重定向拦截。

## 公网网站实测

在公网主站用已配置密码登录，从包含 project/run 的 URL 进入实际项目：状态已完成、五阶段显示、390px 无横向溢出、零页面错误。通过网站打开 index.html，实际新增需求，关闭重开后仍存在；单文件下载得到真实 index.html，内容含实际应用源码。此检查没有修改服务器项目或再次启动模型。

升级前确认活动任务为 0，对原代码和 SQLite 做一致性备份：`/opt/openhands-control/releases/pre-development-5.1-2026-10-26T13-35-24-049Z/`。升级后原有 7 个项目和本次实战项目共 8 个仍在，原有模型账号和存储环境文件保留。控制器、网页、原生执行端、两条远程隧道均设置开机启动。

## 使用边界

手机模拟视口和实际浏览器检查不等同于真机 Safari/Android 全机型验收。静态预览支持经典本地 JS/CSS/图片；需要构建、后端、数据库或复杂模块导入的交付项目按 README 运行。GitHub 私有仓库和网盘账号仍需要各自授权。阶段文件明确标记 partial，不能当作整个项目最终完成。

五 AI 快捷创建复用既有 canvas_save_project 工具和原有通用 state Schema（preset=five-ai），避免依赖移动端新工具列表刷新；完整工作流保存仍兼容。CLI develop create 和旧 CLI 的 projects put 均可调用相同后台。

当前 Codex 对话通过真实插件调用 canvas_save_project，使用最小 state（preset/title/task）访问实战项目，返回完整五 AI 分工且 revision 保持 1，未创建重复项目或启动模型。
