# DSCodex V4.1：Codex 与 DeepSeek V4.1 共存接入

在不修改 Codex 客户端的前提下，把 **DeepSeek V4.1 Flash** 加进 Codex 桌面端 / CLI / IDE 的原生模型菜单，
同时保留 OpenAI（Astra、Sol 等）订阅模型继续走 OAuth 登录。

## 原作者与出处

整套接入思路、loopback 分流架构和绝大部分实现都来自原始项目
[skychentian/codex-deepseek-router](https://github.com/skychentian/codex-deepseek-router)，
由原作者 [@skychentian](https://github.com/skychentian)（仓库内版权署名 `fish2lab`，即最初的 V4 版本作者）
设计和实现。本仓库只是在他的成果上适配 DeepSeek V4.1，**所有功劳归原作者**；如果这套方案对你有用，
请先去给上游点 star。

## 它解决什么问题

Codex 的所有请求只认一个全局 `openai_base_url`。按 DeepSeek 官方接入文档把提供方整体切过去之后，
GPT 模型就不可用了，原来的会话也会因为分属不同登录方式而隐藏。

本项目在本机 `127.0.0.1:10110` 起一个带令牌的 loopback 路由，按**模型名**分流：

- DeepSeek 条目 → `api.deepseek.com` 的原生 Responses API（SSE、工具循环、图片输入）
- 其余模型 → `chatgpt.com` 的 Codex 后端，继续用你的 ChatGPT OAuth 订阅

同一个任务里从 DeepSeek 切回 GPT 时，路由只剔除 GPT 无法验证的 DeepSeek 明文思考项，正文与工具历史保留。

## 相比原项目的改动

本仓库是原作者 [@skychentian](https://github.com/skychentian) 的
[codex-deepseek-router](https://github.com/skychentian/codex-deepseek-router) 的 fork，
针对 DeepSeek V4.1 只做了以下调整：

1. **目标模型换成 V4.1 Flash**：目录条目 `deepseek/deepseek-flash`，上游 wire model `deepseek-flash`。
2. **删掉 GPT 代看图的旧路径**：V4.1 原生支持图片，图片直接发给 DeepSeek，不再借用你的 OAuth 调第二个厂商。
3. **凭据不外流**：DeepSeek 分支只转发 `user-agent`，OAuth token、`chatgpt-account-id`、attestation 头不再发给 DeepSeek。
4. **推理强度如实透传**：`low` / `high` / `max` 原样发送；未指定时用 DeepSeek 自己的默认值 `high`。
5. **目录模板优先取 `gpt-6-astra`**，其次 `gpt-5.6-sol`。
6. **修掉上游 `npm test` 在 macOS 上的失败**：Windows 自启脚本改用 `win32.join` 生成 PowerShell 路径。

## 已验证与未验证

已验证（macOS，2026-09-16）：

- `node --test`：70 / 70 通过。
- 通过本路由的 `codex exec` 真实工具循环：DeepSeek V4.1 与 GPT-6 Astra 都完成了
  “调用 shell 工具 → 读取输出 → 回复”。

未验证：

- 桌面端模型菜单出现 DeepSeek 条目，需要**完全退出并重开** App；本机尚未走完这一步。
- Windows / Linux 未实测。

## 环境要求

- Node.js ≥ 24.5（推荐 Node 26；代理模式依赖 `--use-env-proxy`）
- 已登录的 ChatGPT 桌面端或 Codex CLI（用于 GPT OAuth 模型）
- 一个 DeepSeek API Key（`sk-…`）
- 端口 `10110` 可用（可用 `--port` 或 `DSCODEX_PORT` 修改）

## 安装

```bash
# 1) 存 Key（隐藏输入，绝不会写进 config.toml）
node src/cli.mjs key set
# 或：DEEPSEEK_API_KEY=sk-… node src/cli.mjs key set

# 2) 写入 Codex 配置与模型目录
node src/cli.mjs install

# 3) 起路由并自检
node src/cli.mjs start
node src/cli.mjs doctor
```

`install` 只写两条带标记的根配置（`openai_base_url`、`model_catalog_json`），遇到用户自有的
`openai_base_url` 会拒绝覆盖；修改前会把 `~/.codex/config.toml` 备份到
`~/.codex/config.toml.pre-dscodex.bak`。

装完后**完全退出（⌘Q）并重开 ChatGPT 桌面端**，新建任务，即可在模型菜单里看到 `DeepSeek V4.1 Flash`。
已有任务沿用原模型状态。

### 用真实工具循环验证

```bash
codex -m deepseek/deepseek-flash -c 'model_reasoning_effort="high"' -a never exec \
  --skip-git-repo-check 'call a shell tool exactly once: printf ROUTER_TOOL_OK, then reply with its output'
```

模型必须真的发起工具调用、读到输出并正常结束。

### 可选：开机自启与模型设置桥接

```bash
node src/cli.mjs autostart enable   # launchd / systemd / 计划任务，不嵌入 Key
node src/cli.mjs bridge enable      # 仅 macOS：按提供方分别记忆 effort/speed
```

`bridge` 默认不启用：全局 `CODEX_CLI_PATH` 会让 App 放弃本地 daemon websocket 改走 stdio，
从而破坏 Computer Use。

## 卸载

```bash
node src/cli.mjs uninstall
```

只删除本项目自己写入的配置行、生成的目录、状态文件与 Key 文件，不碰你原有的配置。

## 许可

MIT。上游项目 [skychentian/codex-deepseek-router](https://github.com/skychentian/codex-deepseek-router)
（Copyright © 2026 fish2lab），本 fork 保留其许可证与版权声明，详见 `LICENSE` 与 `NOTICE`。
