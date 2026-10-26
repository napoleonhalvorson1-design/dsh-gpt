# 运行耗时分析

独立 Node.js 22 ESM 模块，零外部依赖。`analyzeRun(run, { now } = {})` 只读取输入，返回可 JSON 序列化的白名单指标；不会复制节点对象、提示词、密钥或文件内容。节点 ID 是唯一输出的业务标识。

```js
import { analyzeRun } from '../shared/run-performance.mjs';
const metrics = analyzeRun(run, { now: 1793066400000 });
```

## 时间与状态约定

时间支持 Date 范围内的安全整数 Unix 毫秒（包括 `0` 和负值），或严格的 UTC 字符串 `YYYY-MM-DDTHH:mm:ss.sssZ`。不接受 Date 对象、数字字符串、小数、无时区字符串、其他时区格式或不存在的日期。`undefined/null` 表示缺失，空字符串非法。不读取 `Date.now()`。

明确的运行中状态仅为 `running`；终态支持 `completed/succeeded/failed/cancelled/canceled`。其他状态语义未知。失败和取消保留所有已知闭合时长，绝不使用 `now` 延长。

只有 run 和节点都为 `running`、阶段起点有效、该阶段及后续终点均未提供、阶段顺序无矛盾时，才能用显式合法 `now` 截止该阶段。若已有后续完成证据，不填补前面的时间缺口。非法或缺失 `now` 不影响已闭合的有效区间；倒退的 `now` 不产生负时长。run 的闭合边界优先使用实际 `finishedAt`，否则仅 `running` 可到 `now`；运行中却已提供完成边界属于语义矛盾，禁止 overall 比例。

缺失、非法、倒序或超出安全整数范围的时长为 `null`，附简短 warning；真实相等端点为 `0`。跨阶段倒序会使 `timelineConsistent` 为 false，仍保留其他可独立证明的局部区间。warning 仅包含代码、可选节点 ID、固定字段名，不回显非法值。

## 返回契约（schemaVersion: 1）

顶层结构：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 固定 `1` |
| `elapsedMs` | run.createdAt → run.finishedAt，或合法运行中截止时间 |
| `nodes` | 全部 nodes 自有键对应的指标数组，不按 order 过滤 |
| `modelWallMs` | 已知 submittedAt → finishedAt/now 区间的去重并集长度 |
| `modelWorkMs` | 同一组模型区间长度之和，表示累计模型工作时间 |
| `observedPeakModels` | 已知模型区间的最高同时执行数 |
| `modelCoverage` | `{totalNodes, knownIntervals, complete, kind}` |
| `overall` | `{modelRatio, overheadRatio, nonModelWallMs}` 或 `null` |
| `overallUnavailableReasons` | 比例不可用的固定原因代码数组 |
| `slowestNode` | `{ids, endToEndMs, candidateCount, complete}` 或 `null`，并列保留全部 ID |
| `structureComplete` | 节点容器、节点对象、order、依赖引用是否满足结构约定 |
| `warnings` | `{code, nodeId?, field?}` 数组 |

每个节点输出 `id` 及以下分段（毫秒或 `null`）：

| 字段 | 起止 |
| --- | --- |
| `preparationMs` | startedAt（启动准备）→ inputReadyAt（交接完成） |
| `submissionWaitMs` | inputReadyAt → submittedAt（提交模型） |
| `modelMs` | submittedAt → finishedAt（模型完成） |
| `snapshotMs` | finishedAt → snapshotReadyAt（快照完成） |
| `outputBarrierMs` | snapshotReadyAt → outputReadyAt（桶屏障完成） |
| `dependencyReadinessWaitMs` | startedAt → max(startedAt, 全部直接依赖的 outputReadyAt) |

准备和提交等待与模型执行分开。`dependencyReadinessWaitMs` 需要合法依赖列表、自身 startedAt/inputReadyAt 及全部依赖 outputReadyAt，且依赖最后完成不晚于 inputReadyAt。已知无依赖时为 0；未知时为 null。它仅表示启动后直到依赖均就绪的时间窗口，可能与准备工作重叠，不能与各段相加，也不能证明进程在该窗口内一直阻塞。

节点还含 `endToEndMs/endToEndEnd/endToEndComplete`：起点固定为 startedAt；终点优先 outputReadyAt，其次为满足运行语义且不早于全部已知阶段的 now，再其次为 snapshotReadyAt、finishedAt。缺少这些端点则未知。`endToEndEnd` 标明实际终点（字段名、`now` 或 null）。历史只有 startedAt/finishedAt 时保留已知跨度，但 endToEndComplete 为 false，既不是模型时间，也不是完整桶端到端时长。`endToEndComplete` 需要实际 outputReadyAt、有效起点和一致的已知阶段顺序。

`slowestNode` 仅比较这些已知起止的跨度，不按模型时长比较。候选可能混合不同终点，应结合节点的 endToEndEnd 阅读。`candidateCount` 是有已知跨度的节点数；其 `complete` 只有全部节点都有一致的完整桶端到端区间且结构完整时才为 true。否则只是已知跨度中最大的候选，不能确认真实最慢节点；没有候选时为 null。

`openSegments` 列出使用合法 now 作为截止端点的阶段；`observedToNow` 表示端到端终点使用 now。`timelineConsistent` 表示已知阶段顺序及运行状态无矛盾。节点 `complete` 更严格：终态、全部六个时间有效且顺序一致、所有分段可算。缺字段不会被当作零。

## 完整性与比例

`modelCoverage.kind` 为 `complete`、`observed_lower_bound` 或 `unknown`。complete 需要每个节点都有有效模型区间、明确的终态或可靠运行中语义、无时间顺序矛盾且结构完整。它描述模型观测覆盖，不代表准备、快照和桶阶段完整。部分区间已知时，聚合是观测值/下界；全部未知时三个模型聚合均为 null。有效零长度模型区间算已知，峰值为 0。明确的空节点容器是已知空集合，聚合为 0；缺失或非法节点容器不是已知空集合。

并发峰值采用半开区间 `[start,end)`；同一时刻先结束后开始，零长度区间不制造并发。modelWorkMs 可以大于 elapsedMs，不能作为用户耗时或占比。modelWallMs 才是已观测模型覆盖的墙钟时间。

overall 采用保守规则：run 必须为明确终态、边界有效且 elapsedMs > 0；全部节点为明确终态，全部阶段时间完整一致，全部节点时间落在运行边界内，模型聚合完整且结构可信。运行中、历史缺字段、依赖交接矛盾、未知状态、越界或零分母等情况均为 null，并给出原因。空节点且边界完整、正耗时的终态运行可给出模型比例 0。

`modelRatio = modelWallMs / elapsedMs`；`overheadRatio = nonModelWallMs / elapsedMs`；`nonModelWallMs = elapsedMs - modelWallMs`。这里 overhead 仅指**未被模型区间覆盖的墙钟时间**，可能包括必要准备、交接、快照、桶屏障和其他活动，不能称为可消除开销，也不能用它推断优化收益、CPU/GPU 利用率、计费或关键路径。

order 可省略；提供时必须恰好包含所有节点 ID 各一次。依赖列表必须是唯一的已存在其他节点 ID；缺失列表、未知依赖或自依赖使结构不完整，但仍分析全部节点。模块不调度任务，也不推测依赖图中的因果关键路径。输出数组按 nodes 自有键顺序，调用方可自行展示排序。

## 检查

```sh
node scripts/test-run-performance.mjs
```

测试使用 `node:assert/strict`，覆盖并行、运行中、历史缺字段、倒序、零时长、非法 now、失败取消、相接区间、空节点、结构不一致、依赖交接、比例边界、严格时间格式、白名单输出与输入不变。
