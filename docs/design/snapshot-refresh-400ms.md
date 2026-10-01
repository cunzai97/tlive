# 无动画快照改为 400ms

## 目标和范围

用户实际试用反馈 200ms 容易触发限流、导致更慢，因此将目标刷新间隔和每物理进度卡最小 patch 间隔统一改为 400ms。

- 工作区：`/home/pan/work/tlive-card-snapshot-400ms`。
- 分支：`fix/snapshot-refresh-400ms`；基线：`ad80da6`。
- 保留原 200ms 工作区和 dist，不覆盖运行中的构建，不改 systemd unit 或默认 CLI，不推送远端。
- `FEISHU_SNAPSHOT_REFRESH_MS=400` 同时驱动查询调度的 throttle/base/min/max 和 sender 的物理页保护，没有只修改其中一端。
- 保留首段思考立即出卡、无打字动画、开始时间锚定、慢请求串行合并最新累计快照，以及现有显式限流退避。
- 400ms 是目标请求间隔，不保证手机端到端时延，也不能保证绝不触发限流。详情导航不套进度刷新保护。
- 编辑详情仍保持不展示原始工具输入 JSON、旧行减号/新行加号、权限与快照身份规则。
- 此次没有实现思考限高或滚动；关于消息卡片是否支持原生滚动另查官方资料，不加无文档字段。

## 已执行验证

- 先只修改共享常量：旧 200ms 集成断言出现 4 项预期失败，确认生产真实链路受该常量驱动。
- 更新 400ms 回归：首段立即，后续 patch 在 400/800ms；慢首发 150ms 不在完成后额外等 400ms；600ms 慢 patch 在 400/1001ms（下一 timer tick）只发送最新状态，最大并发一。
- 直接快速终态/结构变化在 0/400/800ms patch，保留每物理页节奏保护。显式限流 backoff 没有被开始时间锚定抵消。
- `npm run check`：typecheck、lint、82 文件 / 814 项通过。
- `npm run test:coverage`：82 文件 / 814 项通过。
- `npm run build`、`node --check dist/main.mjs`、`git diff --check` 通过。
- 日志：`/tmp/tlive-snapshot-400ms-check.log`、`/tmp/tlive-snapshot-400ms-build.log`、`/tmp/tlive-snapshot-400ms-coverage.log`。
- 上述精确时间来自假时钟回归，不是手机实测。

## 部署

待按用户此次请求独立切换，仅重启桥接，保留原客户端，启动后读回环境、fresh status、飞书 ws 与客户端重新注册。真实限流改善仍需新任务验收。
