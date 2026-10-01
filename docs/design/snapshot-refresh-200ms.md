# 无动画的 200ms 最新状态刷新

## 当前用户目标

“流式”指尽快看到模型当前已输出的累计内容，不是飞书客户端逐字播放的动画。首段思考立即出卡；持续输出按 200ms 目标节奏替换为最新快照，不等待一段结束。

## 范围和回退

- 工作区：`/home/pan/work/tlive-card-snapshot-200ms`。
- 分支：`feat/snapshot-refresh-200ms`；基线：`e2dc6e0`。
- 本地实现和构建已完成；尚未部署，当前第一思考修复版与其 dist 保留且没有重启。
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

## 已执行验证

- `npm run check`：typecheck、lint、82 文件 / 807 项全部通过。
- `npm run test:coverage`：82 文件 / 807 项全部通过。
- `npm run build`、`node --check dist/main.mjs`、`git diff --check` 通过。
- 真实 Factory → Renderer → Presenter → Adapter → Sender 接 mocked SDK：首段思考即时可见；长正文/快速输出仍在 200、400ms 写入；没有 CardKit 打字调用或动画配置。
- 慢首发模拟 150ms 后，后续最新状态在 200ms 写入，而不是再等 200ms。
- 600ms 的慢 patch 模拟中，请求起点为 200ms 与 801ms（零延迟续刷下一定时器 tick）；只保留最新累计内容，最大并发为一，没有按旧 delta 积压。
- 直接连续状态/终态更新模拟在 0、200、400ms patch，同一消息没有重复发送；完整实体仍通过原预算检查。
- 上述时间来自可重复的假时钟集成测试，不是手机实测。授权切换后需要用新任务确认真实观感。
