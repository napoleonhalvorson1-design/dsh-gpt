# 负责人和分支并行实现（5.27）

strongest 自主运行的已验证原生入口支持整包交接时，引擎冻结 streamPlanVersion=1。负责人自行选择 direct、delegated 或新的 streamed：提前写计划与稳定接口，然后继续自己的代码。引擎不额外调用模型。历史运行、没有能力的入口与没有提交标记的运行保留原交接流程。

plan.json 示例（其余目标、理由、验收标准与阶段字段沿用自主协议）：

```json
{"schemaVersion":1,"goal":"业务功能","decisions":"服务和页面分别实现","acceptanceCriteria":["功能可用"],"maxParallelNodes":2,"deliveryMode":"streamed","coordinator":{"prompt":"实现服务端，页面由 worker 负责"},"stages":[{"id":"worker","name":"页面","phase":"build","executionProfile":"codex-seoul","prompt":"实现页面，遵循 shared/api.json","dependsOn":[]}]}
```

负责人先写好计划、接口，再原子替换 `.canvas-collaboration/plan-commit.json`：

```json
{"schemaVersion":1,"requestId":"本次提示词中的原生会话 ID","planSha256":"plan.json 完整字节的 SHA-256","files":{"shared/api.json":"该文件完整字节的 SHA-256"}}
```

files 最多 20 项、合计 32 MiB；已有源代码足够时可为空，无需另写报告。负责人提交后保持计划及这些文件的内容与执行位不变，立即在原会话完成 coordinator.prompt，不写 worker 的职责文件。工作分支遵守共享接口，需改接口时使用正常依赖交接，不应提前冻结。

原生助手只抓取声明的文件、计划及对应模型/深度回执，忽略其他进行中的实现。控制器将它们叠加到原始输入基线，验证哈希、会话、模型/深度，并在输入和独立计划快照完整入桶后才扩展 DAG。存储未确认、标记无效或用户取消都不能释放下游。临时交接失败保留负责人会话，稍后重试保存或退回正常交接，不为保存重跑推理。

run.streamingPlan.checkpoint 是不可变公共基线；plan.planCommitted 仅表示可交接，modelCompleted/outputReady 才表示实际完成与入桶。负责人完整成果在自己的正常 checkpoint 中，合成的 `_canvas_coordinator_result` 是 artifactOnly 文件引用，不调用模型、不占推理槽，不计入推理次数或耗时。最终汇合以提前快照为基线，保留负责人和分支的变化；真正同文件冲突仍需解决。verify/deliver 隐式等待负责人完整成果。

控制器重启重连原有会话；停止等待负责人及所有已启动分支确认；保存失败只补存储；增量开发重建双方完整成果。负责人预算恢复仍遵守既有确认停止、最多一次备用与模型锁，沿用冻结接口。并行上限不变，DeepSeek 仍固定 Flash/max。

本地原生文件助手和隔离 HTTP/S3 夹具验证捕获范围、哈希、执行位、并发、重启、停止、最终测试等待及增量重建。未为升级验收调用付费模型；夹具通过不能证明真实项目整体提速 11 倍。
