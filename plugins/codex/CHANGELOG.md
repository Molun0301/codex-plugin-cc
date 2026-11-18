# Changelog

## 1.0.6+ultra.1.fast.4（本机修订）

- 共享服务在没有客户端连接、也没有运行中的轮次时，空闲 15 分钟后自行退出，并清理自身的状态文件和临时目录；可用 `CODEX_COMPANION_BROKER_IDLE_MS` 调整时长。解决派到 worktree 或会话非正常退出时服务常驻的问题。
- 关闭时先停止接收新连接，再关闭应用服务。

## 1.0.6+ultra.1.fast.3（本机修订）

- 派遣、后台运行和恢复对话支持 `--fast` / `--service-tier fast|default`。
- 新增 `/codex:speed <任务编号> <fast|default>`，分别更新后续对话与运行轮次，明确报告部分成功。
- 共享连接支持限定的设置控制请求，保留任务进度通知；状态显示已接受服务档位。
- 在插件服务启动参数中启用 step_model_switching；完成任务优先复用原连接，避免对话写入者冲突。
- 独立保存速度更新结果，避免完成记录覆盖；保留本机既有写入沙箱策略。

## 1.0.6+ultra.1（本机修订）

- 任务派发接受 `--effort ultra`，原样传递给 Codex 应用服务。
- 同步命令、子代理、技能和使用示例，支持派发 `gpt-6.1-sol` 的 ultra 强度任务。

## 1.0.0

- Initial version of the Codex plugin for Claude Code
