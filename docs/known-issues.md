# 已知问题

本页记录目前已知、且与 Easel 使用相关的问题，以及推荐的规避方式。遇到未列出的问题，欢迎向本二次开发仓库提交 [Issue](https://github.com/StarrySea1412/Easel/issues)。

---

## CLI 终端对话中「问答题」后回复重复显示

- **影响范围**：仅 `easel chat`（终端对话）。**Web 工作台不受影响**。
- **表现**：当 Agent 触发一次 `ask_user` 问答题、用户回答之后，Agent 的下一条回复在终端里可能被重复渲染一次（内容正确，只是显示了两遍）。
- **性质**：这是**纯显示层**问题，不影响实际对话内容、产物生成或发布结果。

### 根因

问题位于上游 [OpenClaw](https://www.npmjs.com/package/openclaw) 本体的**会话投影（session projection）**逻辑，不在 Easel 仓库内。

`easel chat` 底层调用 `openclaw tui`，由 OpenClaw 的 gateway-client 负责在终端重建对话记录。当一条实时回复与另一行（例如 `ask_user` 的问答行）发生错误匹配、且两者不共享 transcript identity 时，投影逻辑会把该回复重新插入一次，导致重复渲染。

我们已核实该根因，并在上游的回归测试中复现（修复前 3 条相关用例失败，修复后全部通过）。

### 上游修复进展

修复已提交至 OpenClaw，跟踪 PR：

- openclaw#144730
- openclaw#144892

修复采用四层策略：全内容唯一匹配、要求终端证据、暂定恢复记录、以及在暂定恢复无法表示时保留后续独立 final 可见。

### 规避与升级

- **推荐**：使用 **Web 工作台**（`easel web`，默认 `http://localhost:7860`）。Web 后端从原始事件流自行渲染，不经过上述会话投影逻辑，因此**不受此问题影响**，并且提供比 CLI 更完整的会话、素材、账号、画像、内容库与发布管理能力。
- 若坚持使用 `easel chat`：待上游发布含修复的版本后，升级 OpenClaw 即可解决：

  ```bash
  npm i -g openclaw@latest
  ```

- Easel 安装的是 OpenClaw 全局 CLI（预构建产物），因此我们**不在 Easel 仓库内内置该补丁**，而是跟随上游最新版本。`easel doctor` 已加入 OpenClaw 最低版本检查（≥ 2026.6.11），版本过旧会直接提示升级。

---

## 第三方代理 / 兼容端点 LLM 一直超时（#9、#11）

- **影响范围**：配置第三方代理或 Anthropic/OpenAI-compatible 端点的安装。
- **表现**：`easel ping` 或小请求可能正常，但稍大、带思考的请求持续超时；部分版本上 `setup.sh` 还会报 `baseUrl: expected string, received undefined` 或 `Unrecognized key: "timeoutSeconds"`。

### 根因（已修复）

- 旧版 OpenClaw（如 2026.3.x）的 provider schema 要求 anthropic 配置**原子写入**；逐字段写入时中间态缺 `baseUrl`，整份校验失败。`setup.sh` 已改为整块一次性写入。
- 旧版本不认识 `timeoutSeconds` 字段，单次请求 600 秒空闲超时写不进去，回落到默认短超时，首个 token 稍慢即超时。该写入在老版本上已降级为尽力而为，不再中断安装。

### 建议

```bash
npm i -g openclaw@latest
git pull
bash setup.sh
```

升级后 `easel doctor` 会校验 OpenClaw ≥ 2026.6.11。不升级时安装不再报错，但请求超时受旧版默认超时限制；请确认模型名带 provider 前缀（如 `anthropic/claude-sonnet-4-6`），具体卡在哪一步可看 `easel gateway logs`。
