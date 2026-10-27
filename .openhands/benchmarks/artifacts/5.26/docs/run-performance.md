# 运行耗时分析

Node.js 22，无外部依赖。导入 `shared/run-performance.mjs` 的 `analyzeRun(run, { now } = {})`，得到 schemaVersion 为 1 的 JSON 可序列化结果。函数只读输入，不访问时钟、网络或文件，不复制提示词、密钥、文件内容等输入扩展字段。节点 ID 用于结果定位，不应在 ID 中存储秘密。

时间接受有限的 epoch 毫秒数（含 0）或带明确时区的 ISO 日期时间字符串，秒必填，小数最多三位。非法日历日期、布尔值、数字字符串、无时区时间均无效。null/undefined 表示缺失。缺失、非法或倒序区间返回 null，warnings 给出简短原因，真实零时长仍为 0。

## 指标

- elapsedMs：run.createdAt 到 run.finishedAt。仅 status=running 且结束字段缺失时使用显式 now；不读取 Date.now()。非法结束字段不以 now 掩盖。
- nodes[id].queueMs：运行创建和全部直接依赖 outputReadyAt 的最大值，到 startedAt。dependencies 必须明确为数组，空数组表示无依赖；依赖缺失则未知。这是就绪后的调度等待，不能表示更早的资源排队。
- preparationMs：startedAt → inputReadyAt，启动准备和交接等待。
- submissionWaitMs：inputReadyAt → submittedAt，交接后提交等待。
- modelMs：submittedAt → finishedAt；运行中且模型结束缺失时可延伸到显式 now。只有一端时间不能作为零秒成功，历史 startedAt 不代替 submittedAt。
- snapshotMs：finishedAt → snapshotReadyAt；barrierMs：snapshotReadyAt → outputReadyAt。
- endToEndMs：startedAt 到 outputReadyAt；缺少输出端点时采用已知 finishedAt；正在运行且两者缺失时采用 now。endToEndEndpoint 明示观察边界，因此历史值未必覆盖完整交付流程。
- slowestNode：已知 endToEndMs 最大的节点，附 ID、时长及端点；平局按 order 后补 nodes 键顺序取首个。未知节点不参与比较，所以不是对所有节点的绝对最慢保证。
- modelWallMs：所有有效模型区间的去重并集；modelWorkMs：模型区间时长求和。任一节点模型区间未知或节点集合为空时，两者为 null。knownModelWallMs/knownModelWorkMs 保留已知区间统计，modelCoverageComplete 标记完整性。
- observedPeakModels：已知模型区间的峰值并发；半开区间 [start,end)，相邻区间不重叠，零时长不贡献并发。无已知区间为 null；部分区间已知时只是观察下界，并非实际峰值。
- overall.modelRatio / overheadRatio / nonModelElapsedMs：仅在运行时长大于零、模型覆盖完整、所有节点终态、全部阶段时间有序且处于运行边界内、依赖就绪可确定时提供。分别为模型并集占比、其补集占比和补集毫秒数；否则为 null。终态识别 succeeded/completed/failed/cancelled/canceled。

## 不能推导的结论

并行 modelWorkMs 可能大于 elapsedMs，不能将其直接作为用户等待时间。模型区间的补集只表示没有观察到模型执行的时间，包含必要准备、排队、快照、桶屏障及其他等待；字段名 overheadRatio 不表示可以消除的性能浪费。模型并集也不等于有效计算时间，无法仅据此分析吞吐、成本、关键路径、资源利用率或提速上限。

失败和取消保留实际已知的区间，不自动截断或补零；终态缺失结束时间不会延伸到 now。运行中准备/快照/屏障阶段不推测结束时间。每段独立验证，因此别的字段坏掉不抹去有效实测段，但整体比例会保持未知。输入不完整时不虚构排队、模型起点或交付完成时间。

本地检查：`node scripts/test-run-performance.mjs`。
