# 运行耗时分析

Node.js 22，无外部依赖。接口为 `analyzeRun(run, { now } = {})`，从 `shared/run-performance.mjs` 导入。函数同步、只读、确定性，不读取系统时钟，也不读取文件或访问网络。输出为 schemaVersion 1 的 JSON 数据；只输出节点 ID、指标、固定字段名和 warning，不复制密钥、提示词、文件内容或任意输入属性。

```js
import { analyzeRun } from './shared/run-performance.mjs';
const metrics = analyzeRun(run, { now: Date.now() });
```

时间接受整数 Unix 毫秒或带时区的 ISO 日期时间字符串（秒必需，小数最多三位）；非法日历日期、无时区日期、非有限数值均拒绝。缺失、非法和倒序区间返回 null，warnings 中包含 scope、code、field，不包含原始值。真正相等的两个合法端点返回 0。数字超出安全范围不作为有效时长输出。

## 指标契约

- `elapsedMs`：run.createdAt 到 run.finishedAt。运行中且 finishedAt 缺失时使用显式 now。
- `nodes`：按 order 中有效 ID 去重排序，再追加其余节点。每个节点保留 id 及以下指标。
- `queueMs`：所有依赖 outputReadyAt 与 run.createdAt 的最大值到 startedAt；显式空 dependencies 表示无依赖。依赖未知、未完成或字段缺失时为 null。它是依赖就绪之后的等待，不包含依赖执行时间，也不代表某个具体调度器队列。
- `preparationMs`：startedAt → inputReadyAt；`submissionWaitMs`：inputReadyAt → submittedAt。
- `modelMs`：submittedAt → finishedAt；`snapshotMs`：finishedAt → snapshotReadyAt；`barrierMs`：snapshotReadyAt → outputReadyAt。
- `endToEndMs`：startedAt → outputReadyAt。活动节点可观察至 now。终态历史节点缺少 outputReadyAt 时，使用 finishedAt 或其后的最后已知快照时间，标记 unknown_tail；这是已观察跨度，下游不能当作完整交付耗时。`endToEndEndField` 指明端点，`endToEndComplete` 指明是否已知桶屏障完成。已知里程碑倒序时端到端时长为 null。
- `timingComplete`：该节点所有里程碑齐全、顺序正确、依赖就绪等待可计算，并位于运行边界内。
- `modelWallMs`：已知合法模型区间的去重并集，表示至少一个模型正在执行的墙钟时长。
- `modelWorkMs`：这些区间的时长总和，表示累计模型工作量。并行时它可以超过 elapsedMs，不能作为用户耗时。
- `observedPeakModels`：这些区间的最大并发。使用左闭右开区间，同一时刻结束和开始不重叠，0ms 区间不增加并发。数据不全时只能表达已观察峰值。
- `modelIntervalsComplete`：每个列出的节点都有可计算模型区间，包括运行中的观察区间；不表示整个运行已完成。部分节点未知时仍返回已知区间统计，必须同时读取此标记。非空节点集合却没有任何合法模型区间时，三个模型统计均为 null；空节点集合返回 0，表示空集合统计，不表示运行成功。
- `overall`：只有非空节点集合、每个节点 timingComplete、模型区间完整且 elapsedMs > 0 时，返回 modelRatio、overheadRatio、nonModelWallMs；其他情况均为 null。modelRatio 为模型并集除以运行耗时，overheadRatio 为其补集比例。所有比例范围为 0～1。
- `slowestNode`：在可计算的端到端观察跨度中选取最大值，包含 id、endToEndMs、endField、complete；无可比较节点时为 null，并列时取输出顺序第一项。历史节点的尾部未知时，这只是已知跨度的排序，不能证明真实完成时间最慢。

## 运行中与历史数据

运行处于 queued/running/reconnecting/stopping/in_progress 时可使用 now 计算当前耗时；节点 running/in_progress/reconnecting，或明确 modelCompleted=true、outputReady=false 的 succeeded 节点，可观察其当前阶段到 now。只有最后一个已知里程碑后面的当前阶段可以使用 now；未来里程碑、倒序时间链、非法端点不能用 now 修补。缺失 now 不会自动读取当前时间。阶段缺失 warning 在观察至 now 后仍保留，说明尚无真实结束记录。

终态识别 completed、succeeded、success、failed、error、cancelled、canceled。失败与取消不会抹掉已知的实际时长。其他状态只计算明确给出的端点，不猜测活动状态。仅有 startedAt/finishedAt 的历史数据可计算已观察跨度，但模型时间必须为 null，绝不假设 startedAt 是模型提交时间。独立合法的阶段仍可计算，即使其他阶段不合法；总体比例则拒绝不完整或矛盾的时间链。

## 不能推导的结论

overheadRatio 为兼容指标命名，其含义严格是“没有已观察模型执行的墙钟比例”，不是可消除开销。准备、交接、快照、桶屏障可能是必要工作，也可能与其他模型执行重叠。不可把各节点阶段直接相加作为运行耗时，也不能从这些数据证明性能瓶颈、关键路径、可节省时间或优化收益。输入未列出的节点或调用无法被检测；完整性仅相对于给出的节点集合。

下游直接消费 null 与完整性标记，不用 `value || 0`，不把未知显示为成功的 0 秒。节点 ID 应为普通标识符，勿在 ID 中嵌入敏感内容。

检查命令：`node scripts/test-run-performance.mjs`。

API：鉴权后的 `GET /runs/ID/performance`；网站代理 `/api/runs/ID/performance`；CLI `canvas runs performance --id ID`；MCP `canvas_run_status({id,view:"performance"})`。不启动模型、不修改运行，也不读取产物文件。
