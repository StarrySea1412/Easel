# 138工具修复与OpenClaw更新评估 / Runtime repair and update assessment

2026-10-14，当前为已实现候选，尚未通过138端到端验收或切换。

截图对应真实会话 `6a3bb3e1-bfb3-5417-abb0-5f85fe6378a0`。权威 transcript 确认技能读取和ls使用了缺少`openclaw/`层级的路径，共享标题参考也被拼到技能私有references；搜索明确报告未启用/provider缺失；复杂双引号多行Python中的反引号触发shell语法错误。另有curl/file缺失。修复分别提供准确技能路径、独立命令规则、固定官方DuckDuckGo provider及镜像工具。

环境安装页增加当前服务实际OpenClaw版本、官方npm最新版本、重新检测、固定版本官方记录链接和“让Agent评估更新”。官方记录限大小、限版数、缓存，失败或缺失明确标注；评估通过新会话使用现有Agent链路，保留旧会话及草稿，给出收益、当前用途相关性、兼容风险、建议及必要验证，不自动安装或重启。当前固定兼容运行时仍为2026.9.6，官方latest查询结果不能当作已升级。

原生浏览器采用独立认证CDP容器：无应用data/state挂载、无公开端口、uid1000、cap_drop ALL、只读根、临时浏览器profile、内存/pid限制。专用AppArmor与seccomp仅允许该容器的Chromium用户命名空间沙箱，未使用no-sandbox，未关闭宿主全局限制。安装仅使用随机运行时浏览器凭据。

验证进度：定向Python39通过，Windows软链接1跳过（服务器补验）；真实React卡片2通过、设置导航27通过，使用模拟HTTP，不能当作真实浏览器/真实Agent证据；生产构建通过。隔离真实搜索/网页/浏览器、技能read/exec/产物、官方更新评估、正式备份切换/登录/SHA/UI对账待完成。完整恢复专项、代表性负载、全菜单、平台/付费媒体和Windows打包继续保留原边界。

The runtime card reads the selected installation and official npm/GitHub sources. The Agent assesses release relevance, benefits and compatibility risks in a new conversation; it does not install or restart anything. Source/unit and simulated component checks passed, but isolated and live acceptance are still pending. Chromium uses a dedicated authenticated, sandboxed sidecar without application data mounts or published ports. OpenClaw remains pinned to the tested runtime, independently of the official latest version.
