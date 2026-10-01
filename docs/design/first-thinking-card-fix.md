# 首个思考块即时展示修复

## 范围与回退

- 独立工作区：`/home/pan/work/tlive-card-first-thinking`。
- 分支：`fix/first-thinking-card`；基线：`794a225`。
- 用户确认后已仅切换桥接到本修复；原生流式工作区 `/home/pan/work/tlive-card-native-streaming` 及其 dist 保留作为回退，原客户端未重启。

## 已复现的问题

- `MessageRenderer.getRenderInput` 与 `ProgressContentBuilder.getStateSnapshot` 没有将思考文本计入是否开始执行的条件，只有思考时仍标记 `starting`。
- 同一场景的纯文本载体始终是 `⏳ Starting...`，没有反映首段思考内容。
- `collectFlowItems` 在活跃时间线尚无正文时将载体添加为 `fallback-body` 模型正文，令真正仍在生成的思考不再是最新语义块，默认按已完成处理并折叠。
- 新增 5 个回归用例在基线全部失败。可确定的是首思考状态及可见性错误；这不等同于已经证明真实客户端期间完全没有发送任何卡片，实际出卡感知仍需新任务复测。

## 修复

- 只有思考时同样进入 `executing`；初次刷新保留零等待调度，不等待正文、工具或完成事件。
- 纯思考输出形成非空、带实际内容的刷新载体，持续片段能够触发后续刷新；异步快照保持独立。
- 活跃且存在时间线时，以时间线为准，不再把启动提示/进度摘要当作正文补到末尾；仍保留无时间线旧载荷以及终态正文的兼容回退。
- 首思考块在生成期间保持展开；连续片段更新同一实体与组件；开始正文后按原规则折叠，结束时关闭流式。
- 编辑详情、预算、分页和现有启动配置不改变。

## 验证

- 新用例先红后绿：renderer 首段即时刷新 1 项，分块启动/执行状态 2 项，真实 Factory → Presenter → Adapter → Sender → mocked SDK 路径 2 项。
- 集成用例分别覆盖没有启动卡、已有启动卡；在无正文、无工具、无完成事件时确认卡引用发送、思考内容写入、展开状态及同一实体持续更新。
- 定向 3 文件 / 91 项通过。
- `npm run check`：typecheck、lint、全量 82 文件 / 801 项通过。
- `npm run test:coverage`：82 文件 / 801 项通过。
- `npm run build`、`node --check dist/main.mjs`、`git diff --check` 通过。
- 手机出卡时机、手动折叠保持仍待用户用新任务验收；以上自动化结果不是平台视觉验证。

## 已授权运行切换

- 代码提交 `d7dc1dd`；仅核实并 SIGTERM 原 bridge PID `892748`，以修复工作区 CLI `start --standalone` 独立启动。
- 新 bridge PID `909569`，fresh status readyAt `2026-10-01T02:41:35.114Z`；新日志已确认飞书 ws 就绪及相同 local 客户端重新注册。
- 原 client PID `793041` 的命令行与工作目录保持不变；`TL_FS_CARD_FLOW=blocks`、`TL_FS_NATIVE_STREAMING=true` 已从新进程环境读回确认，桥接没有代理变量。
- systemd unit 均未激活，文件哈希及默认 CLI 路径/内容均未改变；旧工作区和 dist 未覆盖。
- 运行记录：`/home/pan/.tlive/runtime/card-first-thinking-trial.json`。旧详情快照因桥接重启失效，需新任务进行视觉与按钮验收。
