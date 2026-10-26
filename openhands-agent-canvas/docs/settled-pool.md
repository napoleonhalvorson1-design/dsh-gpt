# settledPool

Node.js 22，无外部依赖。用于并发同步彼此独立的根任务：

```js
import { settledPool } from '../shared/settled-pool.mjs';

const results = await settledPool(roots, async (root, index, signal) => {
  return syncRoot(root, signal); // 根任务内部继续维护自己的执行顺序。
}, { concurrency: 4, signal: controller.signal });
```

接口：`settledPool(items, worker, { concurrency = 4, signal } = {})`。
`items` 必须是数组，`worker` 必须是函数，`concurrency` 必须是 1–32 的整数；
`signal` 可省略，否则必须是有效的 `AbortSignal`。参数不合法时，返回的 Promise
在任何 worker 启动前拒绝（类型错误为 `TypeError`，并发数错误为 `RangeError`）。

按输入索引递增派发，最多同时运行 `concurrency` 项；有空槽才派发下一项。
不修改输入数组，空输入返回 `[]`。结果与输入等长且索引对应：

- 成功：`{ status: 'fulfilled', value }`。
- 同步抛错或异步失败：`{ status: 'rejected', reason }`，不阻断其他项。
- 取消后尚未派发：`{ status: 'skipped' }`。

worker 接收原始条目、索引和原始 signal，可同步返回或返回 Promise。
返回值和错误原因原样保留，不序列化、不打印；调用方按索引检查结果并自行处理失败。

取消仅阻止后续派发；预先取消不会启动任何 worker。已启动项仍等待真实完成，记录成功
或失败后池才返回。signal 会传给 worker，由 worker 决定是否响应；池不宣称远端操作
已停止。若已启动项一直不结束，池也会一直等待，不提供重试或超时。

调用方须保证同一远端对象的顺序：版本、指针、日志等有依赖的操作应在同一个根任务内
依次 `await`，只将相互独立的根任务交给池。5.15 已接入 `Storage.sync`：无开发运行时最多
16 个后台根任务，有开发运行时最多 4 个；同一项目的版本与指针、同一运行的日志块与
索引、产物与清单仍按原有顺序写入。单个根失败不会阻断其他根，完整同步失败仍如实报告。

`lastSyncBatch` 返回本轮开始/结束、并发、fulfilled/rejected/skipped 根计数及最多 20 个
失败根的 kind/id，不返回原始 provider 错误或凭据。这些是已处理根计数，包含无需重新上传的
根，不是 S3 请求数。失败后保留成功回执，下一轮只补未确认部分；全部成功才推进 lastSync。
关闭时停止排队、取消本进程网络等待，并等待已启动的根结束后才关闭数据库；不宣称远端写入
必然被撤销，未知结果下轮按原对象键补传。同一轮重叠 sync 调用返回 busy，不开启第二个写入者。

真实五 AI 开发入口已用一次 Astra/xhigh 调用产出本模块、测试及初稿，成果经过 S3 快照校验。
后台同步组件比较可运行 `node scripts/test-storage-sync.mjs BASELINE_CHECKOUT`；该脚本使用签名
S3 HTTP 夹具，固定每请求延迟，不调用模型，不是整项真实开发的速度证明。

检查：`node scripts/test-settled-pool.mjs`。
