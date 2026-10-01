# 首个思考块即时展示修复

## 范围与回退

- 独立工作区：`/home/pan/work/tlive-card-first-thinking`。
- 分支：`fix/first-thinking-card`；基线：`794a225`。
- 当前运行仍在原生流式工作区 `/home/pan/work/tlive-card-native-streaming`；本修复未部署，未覆盖其 dist、未重启任何进程。

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
- 手机出卡时机、手动折叠保持仍待授权切换后由新任务验收；以上不是平台视觉验证。
