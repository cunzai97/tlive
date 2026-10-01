# 无动画的 200ms 最新状态刷新（历史记录）

> 当前默认已因实际限流反馈改为 **400ms**，见 [400ms 刷新调整](snapshot-refresh-400ms.md)。以下保留原 200ms 的实现、测试与部署记录，不作为当前节奏说明。

## 当前用户目标

“流式”指尽快看到模型当前已输出的累计内容，不是飞书客户端逐字播放的动画。首段思考立即出卡；持续输出按 200ms 目标节奏替换为最新快照，不等待一段结束。

## 范围和回退

- 工作区：`/home/pan/work/tlive-card-snapshot-200ms`。
- 分支：`feat/snapshot-refresh-200ms`；基线：`e2dc6e0`。
- 实现、构建和验证已完成；用户确认后已独立启用本版。第一思考修复版与其 dist 保留作回退，原客户端没有重启。
- `TL_FS_NATIVE_STREAMING=false` 成为配置层、adapter 和 formatter 的一致默认值。显式设为 true 仍可试用历史 CardKit 动画路径，但不作为当前目标。
- 现有运行环境显式设置过 true，切换时必须显式改为 false；不能仅改源码默认值就宣称动画已关闭。

## 实现

- 默认普通 JSON 2.0 卡片，以 IM `message.patch` 全量替换当前页，没有 `streaming_mode=true`、`streaming_config` 或 CardKit `content` 调用。
- 统一常量 `FEISHU_SNAPSHOT_REFRESH_MS=200`；Feishu 查询的 base/min/max 均为该值，不再因输出速度、卡片长度、单次网络耗时将刷新节奏扩大到约一秒。
- 刷新间隔从上次请求开始计算，而非请求完成后再追加 200ms。初次卡片仍零等待调度。
- 每轮只有一个正在发送的请求和一个待刷新的标志。发送期间新增内容保留在最新完整状态中；请求完成后按剩余节奏发送最新快照，不为每个 delta 排队补播。
- 每张物理快照卡额外保存最近 patch 开始时间，普通刷新、工具/终态变化及有限重试都保持至少 200ms 的 patch 间隔；这项保护不应用于文件详情导航卡。
- 保留既有统一预算、稳定消息身份、无损分页、完整正文/思考、详情权限及一详情页一消息规则。
- 200ms 是目标调度间隔，不是手机端到端刷新时延保证。网络、平台处理和限流会使实际可见刷新更慢；此时不并发灌入旧快照，不伪称每 200ms 必然更新。

## 平台依据

飞书“更新已发送的消息卡片”文档确认单条消息更新频控为 5 QPS，更新前后须声明 update_multi=true；超限错误为 230020。现有分类/退避路径保留，明确限流退避不会被开始时间锚定抵消。

https://open.feishu.cn/document/server-docs/im-v1/message-card/patch?lang=zh-CN

## 编辑详情追加调整

- 用户在切换确认时追加了详情展示要求，未选择立即切换；因此先补实现与验证，运行版本继续保持不变。
- 去掉“工具输入快照（仅供核对）”及其原始 JSON 展示，内部仍保留调用内容用于稳定身份、授权和不可变快照。
- 旧片段逐行加 `-`，新片段与写入内容逐行加 `+`；空片段不虚构新增/删除行，缺失片段只提示未知。
- 原文件全文未提供时继续明确标为替换片段，不假装完整文件差异；失败/中断卡保留不代表成功/完成的提醒和完整工具结果。
- 已覆盖 `replace`、`Edit`、`MultiEdit`、写入内容、多行/空行/CRLF/尾换行、长片段分页全文恢复，以及禁止点击时读文件或重跑工具。

## 已执行验证

- `npm run check`：typecheck、lint、82 文件 / 814 项全部通过。
- `npm run test:coverage`：82 文件 / 814 项全部通过。
- `npm run build`、`node --check dist/main.mjs`、`git diff --check` 通过。
- 真实 Factory → Renderer → Presenter → Adapter → Sender 接 mocked SDK：首段思考即时可见；长正文/快速输出仍在 200、400ms 写入；没有 CardKit 打字调用或动画配置。
- 慢首发模拟 150ms 后，后续最新状态在 200ms 写入，而不是再等 200ms。
- 600ms 的慢 patch 模拟中，请求起点为 200ms 与 801ms（零延迟续刷下一定时器 tick）；只保留最新累计内容，最大并发为一，没有按旧 delta 积压。
- 直接连续状态/终态更新模拟在 0、200、400ms patch，同一消息没有重复发送；完整实体仍通过原预算检查。
- 上述时间来自可重复的假时钟集成测试，不是手机实测。已授权切换后仍需要用新任务确认真实观感。

## 已授权独立启用

- 用户已明确确认两项一起切换。运行代码为 `ff9bec9`；旧 bridge PID `909569` 已正常退出，新 bridge PID `962178`。
- 实际工作区和命令行产物为 `/home/pan/work/tlive-card-snapshot-200ms/dist/main.mjs`；fresh status 的 readyAt 为 `2026-10-01T03:32:25.995Z`。
- 新日志确认飞书 `ws client ready`、Bridge started 及原 local 客户端重新注册；client PID `793041` 的命令行与工作目录保持不变。
- 已从新进程环境读回 `TL_FS_NATIVE_STREAMING=false` 与 `TL_FS_CARD_FLOW=blocks`，桥接没有代理变量。启动前后系统 unit 文件哈希及默认 CLI 路径/内容不变。
- 构建产物 SHA-256：`c7de53e07ae92312d2261eb43f2d26510ba3433a74bdb6e821a8849ff17c8dfb`。
- 运行记录：`/home/pan/.tlive/runtime/card-snapshot-200ms-trial.json`；回退工作区：`/home/pan/work/tlive-card-first-thinking`。旧详情快照已因重启清空，需要新任务试用。
