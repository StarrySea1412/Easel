# 生图工坊内的视频生成接口与服务边界

更新日期：2026-10-01。维护仓库：[StarrySea1412/Easel](https://github.com/StarrySea1412/Easel)，开发分支 `codex/creator-workflow`。本说明覆盖接口、协议和服务状态；浏览器验收单独记录，不能以自动测试替代。

## 工作台接口

生图工坊中的视频创作复用模型设置、参考图上传和内容库。任务由现有 `skills/shared/scripts/ai_video.py` 执行；填写凭据后由用户提交，可能产生服务商费用。

| 接口 | 用途 |
| --- | --- |
| `GET /api/videogen` | 返回服务配置状态、当前模型、允许模式/参数、近期视频及任务历史；不返回密钥 |
| `POST /api/videogen` | 创建视频任务；输入 `prompt`、`mode`、`provider`、`ratio`、可选 `duration` / `referenceId` |
| `GET /api/videogen/{jobId}` | 返回 `running`、`done`、`error` 或 `cancelled` 状态 |
| `POST /api/videogen/{jobId}/cancel` | 停止本地生成子进程、轮询和下载；不保证服务商任务取消或退款 |
| `POST /api/imagegen/references` | 沿用图片安全上传，返回可复用的 `referenceId` |

`mode` 为 `text2video` 或 `image2video`。参考图只接收安全上传后的标识，不允许请求指定任意本地路径或外部 URL。`duration=null` 表示使用服务默认时长。界面参数取自服务返回值；后台再次校验，拒绝不支持的模式、画幅和时长。

同时最多运行两个本地视频任务。生成中的视频使用隐藏临时文件，子进程成功、MP4 容器完整且能解码首帧后，才发布到 `outputs/AI生视频/` 并提供 `/api/media/...` 地址。不能将这个检查等同于整段视频的声音、画面、内容质量验收。

失败、超时和取消均不会作为成功视频展示。工作台重启后可以恢复已保存的任务记录和成品；被中断的本地任务会明确报错，服务商仍可能继续生成或计费。删除、移动产物后，不再返回失效的成功播放地址。超时或中断后重试之前，应先查看服务商任务状态，避免重复付费。

## 视频服务和参数

接口沿用六类适配器：DashScope、Ark、Kling、Videos 协议兼容网关、小红书 MaaS、Agnes。列出适配器只表示项目具有请求代码，不表示当前机器已配置、账号有权限、所有模型均支持，或六家均已通过真实生成验收。

- Wan / Ark 已配置模型名包含 `t2v` 或 `i2v` 时，只开放对应模式；不会把文生模型当成图生模型使用。
- Wan 文生视频将画幅转为像素尺寸，例如 `16:9 → 1280*720`。Wan / Kling 图生视频画幅由参考图决定，后台校验所选比例与参考图一致，不发送无效画幅字段。
- 时间、音频和其他能力仍受服务、模型及网关限制。本次界面不提供未经验证的音频、运镜或模型自由输入字段；音频沿用已有脚本的能力配置。
- 视频通道与聊天通道分别配置；不会仅凭聊天 `OPENAI_*` 凭据把视频通道显示为已配置。

## OpenAI 官方服务下线与兼容协议

本轮实际读取的 OpenAI 官方文档明确：**Sora 2 模型和 Videos API 已于 2026-09-24 下线，没有一对一替代 API**。截至本说明日期，不能承诺 `api.openai.com/v1/videos` 可用，也没有因此自动改用其他模型。

来源：

- [官方下线说明](https://developers.openai.com/api/docs/deprecations)
- [Videos 创建接口历史文档](https://developers.openai.com/api/reference/resources/videos/methods/create)
- [视频生成指南](https://developers.openai.com/api/docs/guides/video-generation)

项目保留 `openai-compatible` 供仍提供视频服务的兼容网关使用，并明确阻止调用已下线的 OpenAI 官方入口。该通道必须显式填写 `VIDEO_API_KEY`、`VIDEO_BASE_URL`、`VIDEO_MODEL`，不提供虚构的默认模型。

兼容请求按历史标准 JSON 协议发送：

- `size` 使用 `1280x720` / `720x1280`，不发送 `16:9` / `9:16` 字符串，也不提供 `1:1`。
- `seconds` 使用字符串 `"4"`、`"8"`、`"12"`；省略时使用服务默认值。
- 参考图使用 `input_reference: {"image_url": "data:image/png;base64,..."}`。官方历史文档明确接受该 JSON 格式；本地参考图等比缩放、补黑边到目标像素尺寸，保留整张图而不裁切。
- 任务必须到达完成状态。无成品 URL 的完成任务使用鉴权 `GET /videos/{id}/content` 下载；明确返回成品 URL 的兼容网关也可下载。
- 不将服务凭据发送到响应中的任意成品 URL；鉴权内容端点跨域跳转时剥离凭据。

网关是否真正兼容、是否仍提供某个模型、是否支持图生视频和对应规格，必须由该网关文档、账号权限和真实调用确定。本轮未验证任何网关的所有模型，也没有发起付费生成。

## 已完成的自动验证

新增视频测试覆盖输入校验、引用路径、生成产物、真实 MP4 首帧解码、失败/取消/超时、重启恢复、已删除产物，以及同源写入保护。协议测试使用模拟 HTTP，核对像素尺寸、字符串时长、参考图归一化、任务完成条件、鉴权内容下载、跨域凭据清除和官方下线入口拒绝。

验证命令：

```powershell
python -m pytest tests/test_videogen.py tests/test_imagegen_reference.py tests/test_imagegen_channel.py tests/test_output_image_library.py tests/test_core.py -q
```

自动测试中的外部视频服务均为模拟；真实 MP4 样本仅用于本地文件解码检查。测试通过不代表服务商生成成功。当前机器六类视频服务的配置检查均为未配置，真实生成验收尚未执行。

## 浏览器验收

2026-10-04 在本机 `http://127.0.0.1:7863/`（1280×720 真实浏览器）逐项检查：首页与 `/api/videogen` HTTP 200；生图工坊图片/视频切换正常，视频画布空态、示例、比例（16:9/9:16/1:1）与时长下拉取自服务返回值；六家服务商如实显示未配置，生成按钮据此禁用；「配置视频服务 ↗」直达设置 → 模型配置的视频通道，六张通道卡渲染正常；视频模式下「作品」跳转内容库并预选视频筛选。因本机六类视频服务均未配置，本次未提交真实生成任务，图生视频的参考图比例校验与 MP4 发布路径由自动测试覆盖；该验收不代表任何服务商真实生成成功。
