# 精简规划上下文

`shared/planner-context.mjs` 导出纯函数
`compactPlannerContext({team={}, observations=[], nativeTraces=[]}={})`。
`team` 使用引擎已解析的 `{profileId: config}`，两类记录输入为对象数组。
此模块仅准备数据，接入规划提示由调用方完成，不决定人数、模型、深度或协作方式。

输出 `schemaVersion: 1`。`modelSets` 是去重的 `[原生模型ID, 支持深度数组]`；
`profiles` 是 `{columns:["id","engine","runtimeContextModes","models"],rows:[...]}`。
每行的 `models` 是 `modelSets` 的整数索引数组。例如先按 columns 将行映射为对象，
再用 `profile.models.map(i => context.modelSets[i])` 解析模型能力。
profile 按 ID 排序，深度按 EFFORTS 顺序规范化；相同 ID、不同深度集分别建表，
同一能力跨入口复用。重复定义不丢失能力。不含有效模型的入口省略。

只输出 remote 的三个 ACP 引擎、合法 profile ID 和已验证且具有支持深度的模型。
模型 ID 保持原样，须为非空、无控制字符且最多 160 字符的字符串；深度排除 auto。
DeepSeek 只接受 DEEPSEEK_LOCK.nativeModel 和目录明确支持的 max。
Codex 仅 runtimeContextVersion 严格为 1 时支持 focused，其余只支持 inherit。

非空 observations/nativeTraces 使用各自的 `{columns,rows}`，列名及顺序随数据输出。
记录必须匹配当前有效入口、模型、深度。观测仅接受列出的角色与难度，计数为非负安全整数，
中位数及速率可为非负有限小数；数字缺失或无效均为 null，零保持为零。
成功 samples、失败、无效计划、中断次数及停止前等待分别保留，不从中断推算成功或成功耗时。
原生记录仅接受 dsh-v4-session、DeepSeek Flash/max、工作台运行状态
（queued/running/reconnecting/stopping/awaiting_input/succeeded/failed/cancelled），
且 usageIsLowerBound 必须为 true；其中数字仅接受非负安全整数或归一为 null。
取消记录保留 cancelled，已知 token 下限不代表成功或完整用量。

仅复制白名单字段，不输出地址、凭据、命令、提示词、原生思考或工具文本。
调用方须提供已绑定当前入口的观测；本模块不验证原生会话来源，也不读取历史、访问网络或修改输入。
五入口夹具以 JSON 字符数比较重复目录与矩阵；字符减少不等于 token 数或模型耗时同比下降。

在本应用源码目录检查：`node scripts/test-planner-context.mjs`。

5.23 已接入 planningInstructions：协作说明简化为英文，保留用户任务原文与中文简短交付；能力数据与说明放在用户任务之前。自动选模结合能力、已观测耗时、输出量与成本，由负责人决定，不再预设长代码一定交给某个入口。手动设置、DeepSeek Flash/max、直接交付、并行依赖、执行预算与上下文规则均保留。前缀顺序不代表服务商一定命中缓存，字符减少也不代表实测整体加速。

旧项目及手动模式中，无已验证模型的自托管入口仍以 manualProfiles 的 ID/引擎表提供默认路由；它不宣称这些模型已验证，也不加入自动模型目录。
