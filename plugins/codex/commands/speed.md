---
description: 按任务编号切换 Codex 快速模式或标准模式
argument-hint: '<任务编号> <fast|default>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" speed "$ARGUMENTS"`
