# 0.47.0 · AIHub视觉与Qizhi

用户要求适配图片理解并将Qizhi一起快速更新138；延续不主动发送真实模型复测的要求。

138持久配置的imageModel是aihub/gpt-6.1-sol，provider为openai-responses，但模型条目没有input字段。运行时给缺省条目补text，插件before_tool_call拒绝view_image，尚未向上游发送图片。本轮在保存与启动加载前，仅为已指定AIHub端点和准确模型/协议补齐缺失的[text,image]；显式input限制不变。插件路径、会话归属、交付登记保护保留。

Qizhi合入556528fd与653d8cf2已经完成的适配器、配置UI、远程会话/文件客户端及身份绑定终态结算。设置→模型→Agent底座选择Qizhi；保留当前OpenClaw默认，不迁移已有对话。后端读取CLOUDCLI_*，Key不回传浏览器或入库Git。其文件上传此前HTTP507，不能宣称已恢复；当前UI仅文字与续聊，不冒充本地附件/技能能力。原分支证据见[Qizhi文档](qizhi-agent-integration-2026-11-06.md)。

部署身份与必要检查完成后追加。未执行本轮真实视觉/生图/Qizhi业务调用，最终业务由用户验收。

定向检查：Python 134 passed / 2 skipped，Linux发布工具24 passed，前端相关97 passed；生产build和lint通过（原有警告）。当前发布工具支持BuildKit本地内容寻址别名，避免把sha256裸ID误当远端镜像名。
