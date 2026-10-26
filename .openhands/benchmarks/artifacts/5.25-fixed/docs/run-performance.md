# 运行耗时分析

Node.js 22，无依赖。导入 `shared/run-performance.mjs` 的 `analyzeRun(run, { now } = {})`；返回可 JSON 序列化的白名单指标，不修改输入，不输出提示词、密钥或文件内容。节点 ID 保留用于关联，调用方应使用非敏感 ID。

时间接受有限的 Unix 毫秒数（含 0）或 Date.parse 可解析的时间字符串；建议使用含时区的 ISO 字符串。缺失、非法、倒序时间不转换成零，相关指标返回 null 并附简短 warnings。节点任意已知里程碑倒序时，该节点所有时长作废。非法末端不回退到较早末端。状态 running/in_progress 才允许使用显式 now，不读取系统时钟；其他状态不推断仍在执行。

## 指标

- `schemaVersion`：1。
- `elapsedMs`：运行 createdAt 到 finishedAt；运行中缺失 finishedAt 时使用 now。
- `nodes[id].preparationMs`：startedAt 到 inputReadyAt，包含启动准备和交接等待。
- `submissionWaitMs`：inputReadyAt 到 submittedAt，区分于模型执行。
- `modelMs`：submittedAt 到 finishedAt；运行中且没有完成或后处理时间时可到 now，标记 modelProvisional。
- `snapshotMs`：finishedAt 到 snapshotReadyAt。
- `outputBarrierMs`：snapshotReadyAt 到 outputReadyAt。
- `endToEndMs`：startedAt 到最新声明的完成边界，依次选择 outputReadyAt、snapshotReadyAt、finishedAt；均缺失且运行中时到 now。endBoundary 明确其含义，endToEndProvisional 标明运行中观测值。历史记录只有模型完成边界时，此值不包含未知后处理。
- `modelWallMs`：所有有效模型区间的去重并集，是真正被模型区间覆盖的墙钟时间。
- `modelWorkMs`：有效模型区间时长之和，并行时可以大于用户等待时间。
- `observedPeakModels`：已知区间最大并发数。区间为左闭右开，同刻结束和开始不算重叠；真实零时长区间贡献 0 并发。
- `modelCoverage`：每个节点都有有效模型区间才为 complete；部分有为 partial；全无为 unknown。全无时三个模型汇总指标均为 null，部分有时是已知部分的统计，不代表整个运行。
- `overall`：仅当所有节点六个阶段时间完整有效、模型区间都位于有效运行区间内、elapsedMs 大于零时给出 modelRatio、overheadRatio 和 overheadMs。比率范围为 0–1；overheadMs 是运行时间减模型并集的墙钟余额。
- `slowestNode`：已知 endToEndMs 最大的节点，包含 ID、时长、边界及 provisional。并列按 order 顺序选择，未列出的按 ID 排序；没有有效候选时 null。

## 不可推导的结论

overhead 是描述性余额，包含必要等待、调度、准备及后处理，不能称为可消除开销。并行时模型与其他节点准备可能重叠，各节点准备时长之和也不能当作整体开销。即便全部时间完整，也不能由这些指标判断优化潜力、成本、关键路径或模型速度优劣。dependencies 不用于臆测排队起点或执行时间。

历史 startedAt/finishedAt 只能给出这两个边界间的端到端观测，不能把 startedAt 当作 submittedAt。单端模型时间不是零秒成功。失败、取消仍保留实际已知区间。部分数据的并集、工作量和峰值仅是观测下界；最慢节点也是已知候选中的结果，不保证未知节点更快。不同 endBoundary 的端到端值覆盖范围不同，应结合边界解读。

检查：`node scripts/test-run-performance.mjs`。
