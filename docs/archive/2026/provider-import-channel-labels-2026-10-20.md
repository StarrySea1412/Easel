# 渠道标识、导入直达与 Responses 协议（0.8.1，2026-10-20）

## 用户反馈与目标

1. 同一渠道可有多个模型，但模型菜单只显示模型名，无法判断来自哪个渠道 → 在每个模型处显示渠道昵称。
2. 导入列表把同一渠道按模型拆成多行，并显示“将替换：……”预览和二次确认 → 改为按渠道去重、可直接导入，后续在供应商编辑区修改。
3. 使用 Responses 协议的配置被直接判为不可导入 → 对话通道支持 `openai-responses`。

## 实现

### 模型菜单显示渠道昵称

`ComposerModelPicker.tsx` 的选项标签从 `${model}` 改为 `${channelName || provider} · ${model}`，展开行描述同步给出渠道与模型；选中后触发按钮也显示同一标识。数据来自已有的 `channelName`（`/api/agent-office/models` → `_channel_labels()`），未新增后端字段。

### 导入按渠道去重、直接导入

- `web/local_config_import.py`：`_expand_models` 改为 `_with_models`，每个 provider 只产生一个候选，候选新增 `models: string[]`；OpenClaw 与 CC Switch（SQLite/JSON）三条读取路径统一。
- 预览响应不再需要逐模型 token；`ImportApplyRequest` 新增可选 `model`，apply 只在候选模型列表或本次枚举结果中选择，否则拒绝。
- `SettingsPanel.tsx`：导入列表每条渠道显示模型下拉（多个模型时）、“获取该渠道模型”和“导入”按钮；删除“将替换”行、单选与确认勾选；导入后候选项从列表移除，后续在模型编辑区修改地址/协议/模型。
- 导入仍保留十分钟预览有效期、源文件与目标配置指纹校验、密钥不回传前端、原子写与回滚。

### Responses 协议

- `_CHAT_APIS` 新增 `openai-responses`；保存、协议回读、模型枚举、导入协议族判断均接受该值。
- 导入兼容性按传输族判断：OpenAI Chat Completions 与 Responses 同族，可导入 `openai` 槽位；Anthropic Messages 独立。
- `ProviderBoard` 协议下拉新增 “OpenAI Responses（/v1/responses）”。
- `web/model_health.py` 新增 Responses 请求体（`input` / `max_output_tokens` / `input_image`）与响应解析（`output_text` 或 `output[].content[].output_text`），可用性检测不再拒绝该协议。

## 验证

- 后端：`test_model_import.py`（含 Responses 导入与去重）、`test_model_health.py`（Responses 请求与解析）、模型选择与办公室控制套件通过。
- 前端：`composer-model-picker`、`settings-backup-navigation`、`chat-model-selection` 定向通过；`tsc -b --noEmit` 与生产构建通过。
- 未发起真实模型推理；测活按钮仍由用户手动触发。138 与安装器未更新。

## 2026-10-21 后续界面与验证

- 账号未确认/检测中统一动态loading点，绿/红只用于确定态；10分钟自动核验冷却，发布前单独核验。
- 消息设置可引用主/侧聊，新增/追加/替换目标先进入编辑器；原生alert/confirm改应用弹窗，运行记录补骨架屏。
- 前端全量1252项通过，构建与lint通过；7880账号点、详情说明、侧聊引用及确认弹窗取消有真实浏览器证据。
- 合并后端全量仍有236失败/54error，未完成A/B/C逐条收尾，不作为完整发行验收。见[本机验证与完整待办](local-acceptance-0.8.1-2026-10-21.md)。
