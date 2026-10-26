# settledPool

Node.js 22，无外部依赖。用于并发同步彼此独立的根任务：

```js
import { settledPool } from '../shared/settled-pool.mjs';

let completed = 0;
const results = await settledPool(roots, async (root, index, signal) => {
  return syncRoot(root, signal); // 根任务内部继续维护自己的执行顺序。
}, {
  concurrency: 4,
  signal: controller.signal,
  onSettled(result, index) {
    completed++; // 包括成功和失败，不包括 skipped。
    updateProgress(completed, roots.length, result, index);
  },
});
```

接口：`settledPool(items, worker, { concurrency = 4, signal, onSettled } = {})`。
`items` 必须是数组，`worker` 必须是函数，`concurrency` 必须是 1–32 的整数；
`signal` 可省略，否则必须是有效的 `AbortSignal`；`onSettled` 可省略或为 `undefined`，
否则必须是函数。参数不合法时，返回的 Promise
在任何 worker 启动前拒绝（类型错误为 `TypeError`，并发数错误为 `RangeError`）。

按输入索引递增派发，最多同时运行 `concurrency` 项；有空槽才派发下一项。
不修改输入数组，空输入返回 `[]`。结果与输入等长且索引对应：

- 成功：`{ status: 'fulfilled', value }`。
- 同步抛错或异步失败：`{ status: 'rejected', reason }`，不阻断其他项。
- 取消后尚未派发：`{ status: 'skipped' }`。

worker 接收原始条目、索引和原始 signal，可同步返回或返回 Promise。
返回值和错误原因原样保留，不序列化、不打印；调用方按索引检查结果并自行处理失败。

可选的 `onSettled(result, index)` 在每个已启动 worker 真正结束后恰好调用一次，
按观察到的完成顺序通知；`result` 就是结果数组中的 fulfilled/rejected 对象，
`index` 是原索引，skipped 不通知。省略时行为不变。回调可同步返回或返回 Promise；
通知完成前持续占用本槽，形成背压，worker 与其通知整体受并发上限约束。

通知同步抛错或异步拒绝时，立即停止后续派发；其余已启动 worker 及通知仍须全部排空，
之后池以最先观察到的通知错误拒绝，保留错误身份（包括 `undefined`）。worker 失败
仍只记录为该项 rejected 并通知，不重试；通知失败不会改写该项结果。

取消仅阻止后续派发；预先取消不会启动任何 worker。已启动项仍等待真实完成，记录成功
或失败并完成通知后池才返回；取消本身不会导致池拒绝。signal 会传给 worker，由 worker
决定是否响应；池不宣称远端操作已停止。若已启动项或通知一直不结束，池也会一直等待，
不提供重试或超时。

调用方须保证同一远端对象的顺序：版本、指针、日志等有依赖的操作应在同一个根任务内
依次 `await`，只将相互独立的根任务交给池。本模块尚未接入真实 `Storage.sync`。

检查：`node scripts/test-settled-pool.mjs`。
