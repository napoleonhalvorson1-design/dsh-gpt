# DeepSeek 原生数字诊断（5.20 / 插件 2.19）

任务长时间没有完成时，使用 `canvas runs trace --id RUN --node NODE`；MCP 对应 `canvas_run_status({id,view:"trace",nodeId})`。新 schema 未刷新时用 CLI。只读取现有记录，不启动模型、不创建项目、不修改运行状态或账号设置。当前仅支持配置了 nativeTrace 的 DSH v4 DeepSeek 入口；Codex、Claude 和没有日志的旧运行返回 unavailable。

先核对运行及节点。诊断校验本次 runtime-selection 回执中的 requestId、Flash 模型和 max 深度，且要求一个工作目录只对应一个原生会话，日志头的工作目录和 ID 必须一致；多会话目录不按时间猜测。入口地址须与冻结配置相同。原生日志在对应服务器解析，只返回数字与有限工具类别，不传提示词、思考内容、命令、参数、工具结果、凭据或日志路径。

summary 的 knownTokens 只累计已确认 usage 的 assistant 消息，忽略 stream 中的重复 usage；无计数时为 null。usageIsLowerBound 始终 true，不能当账单总数或完整用量。maxStepOutputTokens 是提供商的 outputTokens，不等于最终回复字数，也不区分推理与文本。maxBeforeToolMs 包含工具调用前的模型等待和生成，不能单独归因为服务排队或思考。knownToolMs 是已匹配工具区间的并集，平行工具不重复计时；timingIsLowerBound=true。最多返回最近 20 步。

activeStepMs 是仍打开步骤的已观测时长；turnEnded 只表示原生记录结束，不能代表工作流成功。实时压缩文件可能尚未写完，traceReadComplete=false 仅表示读到部分完整行。损坏、歧义、配置变化和超出限制返回 unavailable，不凭推测补零或改状态。

最近读取的数字在本控制器内存保留最多 64 个会话。最强负责人可获得最近最多 5 条、同入口且模型仍已验证的摘要，作为分工、并行和执行预算的参考；它们独立于成功耗时样本，取消不算成功，也不用于能力排名。重启后重新读取诊断即可恢复摘要。不要仅因输出计数大就自动停止；按用户需求、阶段预算和实际成果决定。DeepSeek 始终 Flash/max。

部署侧为 DeepSeek profile 配置 `nativeTrace:{version:1,root:"原生DSH的sessions绝对目录"}`，并确认其服务器有 python3/zstd；此字段不进入模型提示词。当前上海已按实际目录验证，不修改全局 DSH profile 或审批配置。读取上限 16 MiB、最多 50 个候选会话；不直接返回原生错误文本。

历史实证：engine-performance-fastplan-20261027-r1 的 implement 仍为 cancelled。13 步中 12 条完整消息累计已知 outputTokens=116801，最大单步72000；最大工具前等待448431ms，匹配工具区间共557ms。最后一条消息没有完整 usage。因此主要等待在模型请求/生成段，不能把它误判为工具慢；这不是成功开发样本或整体 11 倍提速证明。
