# CLI 单次运行策略

```sh
canvas runs start --project PROJECT_ID --complexity simple --mode balanced --effort high
```

`--complexity` 接受 `auto|simple|standard|complex`，写入本次请求的 `workflow.taskComplexity`；未知、空或缺失值会在提交任务前报错。不传时继承项目原值，包括项目未设置该字段的情况。

`runs start` 的难度、模式和思考深度参数只覆盖本次运行，不保存项目，也不发送项目 PUT。若要保存后续运行的默认配置，使用 `canvas models set --project PROJECT_ID --mode balanced --complexity standard --effort high`。

明确的用户设置优先：本次显式参数覆盖对应项目默认值；未覆盖的工作流字段原样保留。自动策略仍须尊重用户显式指定的模型、模式和思考深度。


自动协作只想给负责人一个初始提示时，使用 `--planning-complexity standard`；不设置全程 `--complexity`，后续阶段的复杂度、模型和深度仍由强负责人决定。显式全程 taskComplexity、模式和深度优先；未提供提示时保留原有自动规则。提示不是原生模型设置确认，仍查看 selectionApplied 和回执。

MCP 单次调用也支持 `canvas_start_run({id,projectId,planningComplexity:"standard"})`，以及需要明确覆盖时的 modelMode、reasoningEffort、taskComplexity。快捷 five-ai 创建会保存两类复杂度，普通项目保存仍使用当前 revision。单次参数不修改项目；续跑继续冻结的原设置。DeepSeek 始终 Flash/max。

Codex 按需求实际范围评估初始提示，不能仅因说明较长就选择最高深度，也不能为提速降低实际复杂工作的判断。涉及状态机、恢复、权限或数据一致性时保留所需深度；不确定则用 auto。最强负责人仍可把困难阶段升级为复杂、高深度工作。

原生设置依据：[OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) 与 [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。此改动使用已有的已验证深度目录，不写账号配置，不开启收费加速档，也不声称动态改变进行中的原生模型设置。
