# 飞书原生流式恢复：设计与本地验证

## 范围和回退

- 工作区：`/home/pan/work/tlive-card-native-streaming`；分支：`feat/card-native-streaming`。
- 基线：`8c6a03b`，包含详情回调缺少话题 ID 的修复。
- 本次没有覆盖正在运行的详情修复工作区 dist，没有改 systemd 或默认 CLI 链接。
- 原生开关：`TL_FS_NATIVE_STREAMING=true`（blocks 默认开启）。设为 `false` 可让新任务走原来的统一预算、无损普通卡 patch 路径；legacy 展示仍使用普通卡。
- 真实运行切换和平台试验需单独授权；本文件是本地验证记录，不是手机界面验收报告。

## 实际接线

`QueryPresentationFactory → MessageRenderer → QueryExecutionPresenter → FeishuAdapter.send/edit → 共享 sender → CardKit`。

不是仅修改没有被查询链路调用的 `createStreamingSession`。进度 formatter 提供语义思考/正文组件身份与当前是否允许流式；首页、详情、媒体等继续使用普通发送方式。

## 流式、预算与续卡

- 实体使用 JSON 2.0、update_multi=true，原生 `streaming_config` 为 print_frequency_ms=70、print_step=1、print_strategy=fast；实际客户端渲染观感尚待实测。
- 先准备原生元数据与组件 ID，再进行共享规划，检查完整卡片、外层转义、递归 tag 与表格；不能用 IM 的小 card_id 引用冒充完整卡片容量检查。
- 生命周期最大 metadata（streaming_mode=false 比 true 更长）进入源预算；每次文本累加后的完整目标卡与实际 CardKit 操作请求都校验软预算。
- 共享 planner 返回源 ID 到每张物理卡最终 ID 的映射。文本更新使用最终组件 ID，不能拿分页前的 ID 调接口。
- 首次创建空语义文本壳，确认 IM 已发送卡引用后才推累计文本，避免先把全文填到未发送实体里而失去首次打字效果。
- 拓扑不变时语义文本使用 cardElement.content；工具状态、折叠属性和辅助文本使用局部属性更新。布局/卡头发生变化才全量 card.update，保留可复用文本前缀后再推增量。
- 长文本、代码、表格仍由原规划器无损续卡。已满历史页关闭流式，语义文本所在活动尾页继续流式；早期块增长按既有规则重算受影响后缀，不把溢出增量丢到无关正文末尾。
- 完成、失败、中断或等待审批时关闭流式；需要恢复生成时重新开启。接近平台自动关闭时限，在后续更新前重新开启。
- 单实体 API 操作间隔至少 120 ms；同实体和同逻辑发送均串行。实际 renderer 原生更新调度改为 base/min=250 ms、max=1200 ms；普通卡保持原调度。

## 幂等和失败

- 每页保留 entity card_id、IM UUID、消息 ID、规划和预算；IM 响应丢失后重试复用实体与 IM UUID。
- CardKit 操作保留 sequence、UUID、原请求和成功后的卡片状态。未知传输错误重放原请求确认，再处理新目标；明确 SDK 拒绝允许下一次递增操作。
- 所有 resolved 非零返回码算失败，权限/格式错误不能假装原生成功或悄悄新发重复气泡。
- 只有容量错误允许有限降预算；旧成功页保留其验证预算，不让新尾部的小预算卡死历史页。
- 关闭流式失败真实抛出，不能把未确认关闭记录为完成。
- CardKit.create 没有请求 UUID 字段：创建响应丢失可能留下一个未发送的孤立实体，不能声称实体创建完全幂等；已取得 ID 后发送层不重复创建实体/聊天消息。

## 详情保持

- 原用户/聊天/来源消息检查及不带 thread_id 的兼容保留；详情回调先于模型队列处理。
- 详情继续普通 JSON 卡，避免把快照输入/结果也当作逐字打印。
- 复核额外发现服务端降预算可能让一个详情导航页拆成多条，关闭只删根卡。新增 feishuSingleCard 合同：如果规划无法保持一导航页一消息，明确失败而不静默发溢出兄弟；避免关闭后留下敏感内容。

## 已执行验证

- typecheck、lint、全量测试和 build 均通过；全量 82 文件 / 796 项。
- SDK 边界测试使用真实 formatter、查询 presenter、adapter、sender 和 planner，覆盖结束前思考/正文更新、首次发送后打印、长 Unicode 续卡与全文、前块增长保序、关闭/重开、限频、超时续开、权限拒绝、CardKit 容量降预算、IM/文本/关闭响应丢失重放及普通卡显式回退。
- 同一实际查询流程覆盖原生主卡上的编辑详情按钮和缺少话题字段的回调；详情不进入模型队列。
- 快照、预算和平台 API 权限不等于客户端视觉验收。真实权限、移动端打字效果、手动折叠保持、真实超限边界、按钮回调时延仍需试用。

## 真实权限探测与运行切换

- 首次探测使用运行桥接的应用身份与本版 formatter/planner 生成的卡片，未发送到聊天；接口返回 `99991672`，缺少 `cardkit:card:write`，因此当时未停止旧桥接或部署。
- 用户确认开通权限后重新探测：实体 `7691519108643179462` 的 `card.create`、两次 `cardElement.content`、`card.update`、`card.settings` 均返回 `code=0`，最终关闭流式。实体未发到聊天；当前 SDK 没有 CardKit 实体内容读取接口，这些是接口响应验证，不是视觉或远端内容读回验收。
- 重建隔离工作区的产物并检查语法后，仅对核实身份的旧 bridge PID `823702` 发送 SIGTERM，再通过本工作区 CLI `start --standalone` 独立启动；原 client PID `793041` 未停止或重启。
- 新 bridge PID `892748`，实际产物 `/home/pan/work/tlive-card-native-streaming/dist/main.mjs`；fresh status 的 readyAt 为 `2026-10-01T02:25:29.062Z`。新日志确认飞书 `ws client ready` 与同一 local 客户端重新注册。
- 新桥接显式设置 `TL_FS_CARD_FLOW=blocks`、`TL_FS_NATIVE_STREAMING=true`，继承原运行环境但剥离代理。读取新进程环境、路径、状态与日志验证运行结果，没有打印或落盘凭据。
- systemd 两个 unit 保持 inactive，文件哈希和默认 CLI 内容/路径均未改变；旧工作区及构建保留作为回退。运行记录：`/home/pan/.tlive/runtime/card-native-streaming-trial.json`。
- 子代理迟到复核针对旧基线；最终树的相关 6 文件 / 80 项回归已重新通过。新版本已运行，但手机逐字效果、手动折叠保持、真实续卡和详情仍待用户用新任务验收；重启清空旧详情快照。
