# 在已完成成果上继续开发（5.17 / 插件 2.16）

新需求基于本项目某次已成功运行时，创建新运行并传 baseRunId，任务仅描述本次改动。MCP：canvas_start_run({id:新唯一ID,projectId:项目ID,task:本次需求,baseRunId:上轮成功ID})。工具 schema 尚未刷新时用 CLI：`canvas runs start --project PROJECT --id NEW_RUN --base-run PREVIOUS_RUN --task-file requirements.txt`。也可在项目完整 state 或 five-ai preset 保存 baseRunId；显式单次覆盖优先。保存配置不调用模型。

先读状态确认来源 succeeded、同一项目及阶段快照有效。未完成任务继续使用 resume，不能把失败的阶段文件当作成功基线。运行固定末级阶段及共同基线的桶快照、conversationId、SHA-256，重建完整成果后归一化为新目录，保留代码、测试、二进制和可执行位，移除旧 .canvas-collaboration 协议数据。并行末级按共同基线合并，保留删除语义；冲突阻止新推理。原运行和原生账号保持原样。

基线归档与清单先完整入桶再启动新 AI，run.artifactSource 包含真实 sourceRunId、archiveSha256、files、bytes、status、checkpoint。prepared 只代表本地归档；ready 才代表通过存储屏障。来源固定后，重启或存储失败只补文件存储，不重跑上轮 AI、不追随来源记录变化、不重新下载 GitHub。对象存储配置变化或哈希不符会阻止执行。每个独立新分支都从相同基线开始，后续汇合继续使用三方语义。

baseRunId 优先于 repository 导入：两者同时设置时，以已完成成果作为开发文件；repository/branch 仍可用于后续 GitHub 交付，不自动导入移动中的 main。每次开发继续遵循独立分支、实际 CI、PR、Codex 对当前 SHA 单独批准后合并。不能因为继承成果省略改动所需的功能检查，也不能声称协议测试证明整体提速 11 倍。
