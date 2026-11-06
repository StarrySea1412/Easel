# 0.47.0 · AIHub视觉与Qizhi

用户要求适配图片理解并将Qizhi一起快速更新138；延续不主动发送真实模型复测的要求。

138持久配置的imageModel是aihub/gpt-6.1-sol，provider为openai-responses，但模型条目没有input字段。运行时给缺省条目补text，插件before_tool_call拒绝view_image，尚未向上游发送图片。本轮在保存与启动加载前，仅为已指定AIHub端点和准确模型/协议补齐缺失的[text,image]；显式input限制不变。插件路径、会话归属、交付登记保护保留。

Qizhi合入556528fd与653d8cf2已经完成的适配器、配置UI、远程会话/文件客户端及身份绑定终态结算。设置→模型→Agent底座选择Qizhi；保留当前OpenClaw默认，不迁移已有对话。后端读取CLOUDCLI_*，Key不回传浏览器或入库Git。其文件上传此前HTTP507，不能宣称已恢复；当前UI仅文字与续聊，不冒充本地附件/技能能力。原分支证据见[Qizhi文档](qizhi-agent-integration-2026-11-06.md)。

部署身份与必要检查完成后追加。未执行本轮真实视觉/生图/Qizhi业务调用，最终业务由用户验收。

定向检查：Python 134 passed / 2 skipped，Linux发布工具24 passed，前端相关97 passed；生产build和lint通过（原有警告）。当前发布工具支持BuildKit本地内容寻址别名，避免把sha256裸ID误当远端镜像名。

## 发布身份

发布源码b5b138780bacad87740ef69e5b50eff1a6ae8ad5已推送starry并核对远端SHA；ZIP SHA256为22d264718267e078f060e045d21f1db7994c6002e098b8d30d8eeaf1eaf28a57，2337项源文件。
138构建镜像sha256:0fb0d6469f9c2e2cc00db26168082f64d585e12d376f3efd23a18edfb2cd5e90，固定复用前版运行依赖；前端0.47.0于138重新构建。
Qizhi配置安全写入服务端.env（0600，保留原属主），旧配置备份/home/ubuntu/easel-secrets/config-backups/qizhi-20261106T092209Z/env-before-qizhi。保留OpenClaw默认底座和AIHub模型，不会把原会话迁到Qizhi。用户授权停止当前轮后，查得该轮已自行completed/resourceSettled=true，因此未再发stop或重放请求。

正式切换后持久配置已读回：imageModel仍为aihub/gpt-6.1-sol，模型input为[text,image]。容器revision b5b13878与镜像0fb0d646一致。停写备份/home/ubuntu/easel-backups/20261106T092622Z.tar.gz（约889MiB，0600）；前版25560370保留。未发起视觉或Qizhi业务复测。

激活时间2026-11-06T09:28:24.872344+00:00，app/browser/proxy全部healthy。容器安装版本0.47.0；使用产品read_settings读取后Qizhi configured=true、keyStored=true、model=gpt-6-sol（没有输出Key，没有请求远程Agent）。该结果仅是配置与启动证据，不是视觉/Qizhi上游业务通过。
