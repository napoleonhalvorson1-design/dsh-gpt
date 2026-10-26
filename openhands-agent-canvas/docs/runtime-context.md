# 按职责选择原生上下文（5.14）

模型目录的 `executionFeatures.runtimeContextModes` 表示入口已确认支持的模式，已安装新策略的三个 Codex 入口可使用 `inherit` / `focused`，DeepSeek 与 Claude 继续继承原环境。没有设置的项目、节点和历史运行全部继承，不自动关闭现有插件。

AI 负责人为纯文件、终端开发阶段设置 `runtimeContext:"focused"`，减少每次原生会话带入的 App、插件与技能目录；需要连接器、插件或相关技能时用 `inherit`。不确定时继承，不能为省上下文丢掉任务所需能力。负责人自己决定，不固定所有节点的环境。项目显式设置 `runtimeContext` 时优先于 AI 阶段提议；创建 preset 或 `canvas develop create` 的输入 JSON 可以携带它。保存不启动推理。

```json
{
  "id": "implement", "name": "实现代码", "phase": "build",
  "executionProfile": "codex-silicon", "prompt": "完成负责文件",
  "dependsOn": [], "runtimeContext": "focused"
}
```

focused 需要已验证模型策略与本机配置探针确认，只对这次 Codex ACP 子进程传入 CODEX_CONFIG：`features.apps=false`、`features.plugins=false`、`features.remote_plugin=false`、`skills.max_context_tokens=1024`。原生文件、终端、模型与思考深度保留，账号配置、凭据、仓库指南与托管要求不改写。此模式不加载 App 和插件功能；需要这些能力的职责必须选择 inherit。未获支持的 focused 在任何原生请求前拒绝，不静默伪装生效。

设置方式来自 [OpenAI 官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference) 与 [配置优先级说明](https://learn.chatgpt.com/docs/config-file/config-advanced)。配置覆盖不能放宽托管要求。原生探针只确认公开配置的有效值，不证明所有运行时行为，更不证明真实项目提速。

`ops/install-execution-policy.mjs` 先安装并校验内容哈希策略，再在三个 Codex 服务以独立短生命周期子进程读取有效配置。探针不创建 thread，不提交 prompt，不启动 Canvas 任务；确认后才原子更新受保护入口文件，并保留原属主、权限、账号和旧策略脚本。失败不切换配置。共享手机 Codex 服务不重启。

配置随运行冻结，明确继续保留原策略路径、模式和能力版本。同能力 Codex 备用继承 focused，其他备用继承其原环境；项目显式强制 focused 时不允许切到不支持的备用。切换后的运行定义记录实际配置，重启或继续不使用旧入口的模式。`node.runtimeContextRequested` 和无推理预览反映请求设置，并不宣称模型已使用某个插件；实际 token 与产物仍看原生用量和校验后的快照。

必要验证：`node scripts/test-runtime-context.mjs`、`python3 scripts/test-acp-policy.py`、`python3 scripts/test-context-probe.py`。这些协议测试不调用真实模型。旧真实任务中观测到的大上下文和 DeepSeek 的晚到部分文件只用于定位，不能算成功的速度比较；整体 11 倍目标仍未达到。
