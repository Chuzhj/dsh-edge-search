# Changelog

本项目从 **v0.3.0** 起开始记录变更。更早的 0.1.x / 0.2.x 属内部迭代版本，
未保留变更记录，故不在此追溯。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.3.0] - 2026-10-19

### 移除（Breaking）

- **移除 `edge_deepseek_chat` 工具。** 网页版对话通道已被官方 Search / Fetch API 取代，
  且 DeepSeek 网页结构改动频繁、维护成本高于收益。
  升级后调用该工具会得到 `unknown tool`。
- `selftest.mjs` 同步移除 `chat` / `chat2` 两个子命令。

### 变更

- 定位收敛为「内置 web 工具的兜底通道」，对外只保留 `edge_search` / `edge_read`。
- `lib/interact.js` 精简：只保留通用的标签页操作（`openTab` 及其句柄方法），
  移除了随聊天工具一起废弃的页面轮询、文本注入、按键模拟等代码。

### 修复

- **`edgePath` 配置项此前不生效。** `ensureEdge()` 没有接收该参数，传进来的值被静默丢弃，
  实际始终走自动探测。现在会正确使用；指向的文件不存在时给出明确报错，
  与「没装 Edge」区分开。

### 文档

- 新增安全说明：CDP 端口监听范围、调试 profile 的隔离性、无遥测。
- 补充「首次运行会弹出独立 Edge 窗口」的说明（原本只在排错表里出现）。
- 补充「更新插件」「关闭调试窗口」「重置 profile」三节。
- 增加 Mermaid 架构图，说明为什么请求不经过 DSH 的 IP 校验。
- 中文设为仓库主 README，英文版移至 `README.en.md`。

---

## 更早的版本

- **0.1.x / 0.2.x** —— 内部迭代，未记录。
