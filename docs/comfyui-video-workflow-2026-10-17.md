# ComfyUI 视频工作流实现记录（2026-10-17）

## 调研结论

`melies.co/cinematic-techniques` 是电影镜头语言资料库，按景别、角度、运镜、镜头、灯光、构图、色彩、时间运动、特效和转场等组织提示词。Easel 采用这些字段的结构，不复制其页面正文或品牌内容。

`ComfyUI-Fantastic-MiniMaxH3-PromptBuilder` 是 ComfyUI 的 MiniMax H3 节点包，重点是结构化提示词、参考媒体和工作流示例。它不是视频服务，也不能替 Easel 假设用户已安装节点、模型或 H3 权重。Easel 只接受用户配置的 ComfyUI API-format workflow，因此可以兼容其他视频节点包。

## 已实现

- `web/comfyui.py`：配置检查、API workflow 读取与节点校验、提示词节点注入、`POST /prompt`、`GET /history/{prompt_id}`、`GET /view` 下载、轮询、超时、取消、重启中断和 MP4 校验。
- `web/cinematic_prompt.py`：主体、动作、景别、运镜、角度、镜头、灯光、构图、色彩、时间、特效、转场、风格字段的有界归一化；未知字段不会进入供应商请求。
- `web/app.py`：新增 ComfyUI 环境配置注册和 `/api/comfyui/video` 路由。配置入口使用现有设置环境保存机制。
- `ComfyVideoWorkflowPanel`：视频工坊中显示配置/连接状态、可选镜头语言参数、提交/本地停止、结果播放和下载。
- `ChatArtifacts`：视频产物直接渲染 `<video controls>`，支持同已有图片/HTML产物一样的刷新和下载。带 `sessionId` 的 ComfyUI 任务会将已校验 MP4登记到 ArtifactStore。

## 配置

在设置的技能/API配置中填写：

```text
COMFYUI_BASE_URL=http://127.0.0.1:8188
COMFYUI_WORKFLOW_PATH=outputs/workflows/video_api.json
COMFYUI_VIDEO_PROMPT_NODE=positive_node_id
COMFYUI_VIDEO_NEGATIVE_NODE=negative_node_id   # 可选
COMFYUI_API_KEY=                               # 可选
```

工作流必须是 ComfyUI 的 API 格式：每个节点包含 `class_type` 和 `inputs`。如果正向提示词节点无法唯一识别，必须填写 `COMFYUI_VIDEO_PROMPT_NODE`；不会猜节点，也不会在失败时自动切换到其他视频供应商。视频节点需要输出可下载的 `.mp4`，Easel 会检查容器、关键 box 和首帧解码后才发布。

## 验证边界

`tests/test_comfyui.py` 使用模拟 ComfyUI 响应覆盖节点歧义、提交、历史轮询、输出下载、ArtifactStore 登记、未配置 fail-closed 和健康路由；前端视频产物回归包含内嵌播放器和刷新路径。没有调用真实 ComfyUI、MiniMax H3、付费视频服务，也没有修改 138 或安装包。真实节点包、模型权重、GPU 性能和最终视觉质量需要在用户自己的 ComfyUI 环境中单独验收。
