# 块式工具流改造：暂停交接

用户要求停止开发并收存进度。以下是暂停时的历史检查点，不是当时可部署的版本。

用户随后已授权继续，最新实现与本地验收结果见 [开发验证记录](card-flow-validation.md)。不要用下面的暂停状态覆盖最新验收结果。

## 保存位置与回退

- 隔离工作区：`/home/pan/work/tlive-card-redesign`
- 开发分支：`feat/block-tool-flow-cards`
- 正式设计文档：`docs/design/card-flow-redesign.md`
- 方案提交：`9dd9665`
- 开发基线：`209f97edea453862b54905274ec2531fa7b8af20`
- 回退分支：`rollback/card-flow-base-20260930`
- 本次改动另作 WIP 提交，提交信息标明暂停与未完成。不要将它当成已验收实现。
- 原工作区 `/home/pan/work/tlive-fork` 及运行中的 dist 未修改、未重启、未部署。
- 原工作区已有 package.json/package-lock.json 修改保持原样；本分支不包含这些用户修改。

## 已落盘（未等同于通过验证）

- 独立思考/输出/工具块、同类连续工具分组初稿；短内容阈值默认50 Token。
- tool-display 注册映射与旧 format-progress-legacy 保留。
- flow-blocks 与新 format-progress 初稿；新增 flow-blocks 测试及旧展示测试显式legacy调整。
- card-budget：序列化字节、外层字符串估算、递归tag/表格数量检查、分段规划、已发分片规划基础。
- sender 已接入一部分新规划逻辑；尚未完成独立复核和发送测试验收。
- tool-details：只从本次输入/结果快照生成详情，独立卡分页、权限/来源绑定、关闭撤回与占位初稿。
- renderer 保留完整输入/结果并脱敏、稳定调用标识、重复start处理、终态、早到结果缓冲。
- Feishu turn 禁用renderer通用12工具reset，准备由sender持有完整续卡拓扑。
- turnId/blockId/deliveryId 等字段、formatter注册详情快照初步接入。
- 配置已增加新/旧模式、分组阈值、容量预算和工具分类覆盖；main已传cardFlow，adapter尚未消费。
- 最终回答不再在presenter按5000字符截断。

## 最后已验证的结果

- 初始主线基线 `npm run typecheck` 通过。
- 事件接入修改后，`npm test -- src/__tests__/engine/message-renderer.test.ts src/__tests__/engine/query-presenter.test.ts`：2个测试文件、21项测试通过。
- 后续模块初稿落盘后跑过全量typecheck，出现2处错误：tool-details元素类型与main传入未声明的cardFlow。
- 之后已修改tool-details元素类型，并做formatter与字段整合，但没有重新运行全量typecheck，因此不能宣称当前类型检查已通过。
- 暂停前 `git diff --check` 通过。
- 没有完成全量check/build/coverage，没有真实飞书验证。
- 并行任务先前发生600秒超时；已有源码落盘，但未收到完整通过报告。暂停时已确认无活跃子代理、无本任务后台构建/测试进程。

## 恢复后的优先事项

1. 先读AGENTS.md、设计文档和本交接，核对git状态。不要覆盖活跃工作区或重启服务。
2. 完成adapter/formatter集成：消费cardFlow配置；调用configureFeishuCardBudget；创建并共享FeishuToolDetails；send/edit后bind所有实际消息ID；详情callback必须在模型路由前消费并校验授权。
3. 核对sender新接口和所有发送/更新路径：非0 SDK响应、平台超限有限降低预算、partial成功保留ID、幂等、reply路由、已发前缀不重排。
4. streaming.ts仍是旧版截断逻辑，需要接入真实无损续卡，不能只加“内容继续中”提示。
5. 完善稳定展示element_id（飞书限制20字符），避免同组插入文本或状态变化导致规划key漂移；核对card-budget对div.text等非markdown文本的处理。
6. 确认工具分类：配置edit与内部editing应显式映射；完整bash命令用inputData而非旧格式化短预览。
7. 真Token计数可注入；当前默认是ASCII约四字符/Token、非ASCII约一Token的估算，不能冒充真实模型tokenizer。真实计数接入和估算行为需要在结果中披露。
8. 详情页必须在配置低预算下仍只产生一个当前页卡片；代理client需要继承原client预算。核对owner和callback用户ID优先级一致、TTL/快照不可变、关闭失败诚实反馈。
9. 补齐新renderer、config、budget、sender、streaming、详情、adapter端到端回放测试；已有新分组测试也尚未验证。
10. 执行完整check/build/test:coverage/diff检查和独立复核。仅隔离worktree构建。不安装依赖，不真实发卡，除非用户进一步授权。

## 边界

只授权独立分支开发，未授权发布、合并主线、推送远端、部署或重启。现有node_modules复用活跃仓库；Pi SDK本机为0.99.1，主线声明0.85.1，需披露验证环境差异，不擅自改依赖。
