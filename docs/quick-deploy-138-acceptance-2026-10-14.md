# 138快速发布实际回执 / Quick deploy acceptance

2026-10-14，已使用 `scripts/deploy_138.ps1` 将固定提交 `12f144c8848fc8a2fbc49a1acbfbbde1e63bb681` 先发布到隔离实例，再发布到正式138。版本仍为0.2.8；包括Google News超时提示、首页热点密度/平台图标、既有OpenClaw版本卡和官方更新Agent评估入口。前端交互验收由用户完成。

## 固定发行身份

- ZIP SHA-256：`bc9887594abbca44bab4b30395d6b62cd604c867d4e8d6edacd40fbb900f4b40`，1573个源码文件。
- 正式/隔离同一镜像：`sha256:82cd8cbddf1a6d5b1044f0c1e4fc73314f1bd78b7dfd3fceccb3957b28bbd770`。
- 运行源码1388项摘要通过，185项文档/测试不进入运行镜像；前端生产构建通过，包内确认包含超时提示。
- 构建方式为 `fixed-runtime-reuse`，基础镜像 `sha256:14393be39cc117bed4e6296e022905f0d560109fcc592bbbc7c6b48a2b470000`。Dockerfile、Node/Python锁文件和项目依赖声明逐项一致；完整应用源码和前端重新构建，依赖未重新安装升级。
- 隔离停写备份：`/home/ubuntu/easel-backups-test/20261014T073813Z.tar.gz`；正式停写备份：`/home/ubuntu/easel-backups/20261014T074623Z.tar.gz`。
- 正式活动源码：`/home/ubuntu/easel-releases/Easel-138-12f144c8848f`。正式及隔离应用/浏览器容器Healthy、重启次数0。

## 实际验证

正式和隔离HTTPS登录均200；未登录版本API均401；登录后的发行SHA正确、development=false、gateway=true。内网测试账号 `gaojitest / gaoji` 登录通过，适用现有隔离/内网测试环境，正常哈希及认证文件保持原样。正式入口为 [https://192.168.0.138:8444/](https://192.168.0.138:8444/)。

运行OpenClaw仍为2026.9.6，官方latest查询为2026.10.3，5份官方更新记录返回。Agent更新评估能力沿用此前已验流程；本轮没有自动升级OpenClaw。正式认证文件、OpenClaw配置和3个旧验收产物摘要保持一致。

| 环境 | 真实会话 | 原始工具回执 | 实际产物及下载 |
| --- | --- | --- | --- |
| 隔离 | `a9a7dcbb-cca1-4119-9b43-f676ae9649f5` | read1、exec3、search1、fetch1、browser2、write1，9次无错 | 1938字节；SHA-256 `3065231b937efdd7acd02868039f2fe79172f99ec21ee9c4563122e7caf04e2a` |
| 正式 | `c1823dea-8f99-4680-a415-a97f937c5d6f` | read1、exec4、search1、fetch1、browser3、write1，11次无错 | 2124字节；SHA-256 `611e20dd534bd9b3daf85e6cf9529a08939419ca6f79b5c03662324a09006a1d` |

工具回执从对应OpenClaw SQLite会话读取，并检查isError、status及exitCode；不以模型声称完成代替工具证据。真实报告下载内容与服务器文件逐字节一致。发布和依赖变化拒绝回归4项通过；超时提示此前17项前端逻辑回归及TypeScript通过，热点此前40项模拟回归/lint/构建通过。

## 快速入口实际修正

真实执行发现并修正了PowerShell Git花括号格式化、Windows SSH换行/引号、旧Docker不支持progress参数、活动候选目录被删除、健康检查过早及隔离回滚提示错误。早期失败均停在激活前。现在上传UTF-8/LF Bash文件执行，同提交目录校验后复用，依赖一致时复用固定运行镜像，激活后等待Compose健康再检查HTTPS。

运行命令分别为 `scripts/deploy_138.ps1 -Commit 12f144c8848fc8a2fbc49a1acbfbbde1e63bb681 -IsolatedTest -Activate` 和同提交的 `-Activate` 正式流程；使用 `-AllowDirty` 仅因为同工作区另有未提交需求记录，发布包仍只来自固定提交。

## 验收边界

Google News原有网络连接超时仍属于目标可达性问题；本次部署改善了准确错误提示，未宣称修复Google网络出口。免费RSS搜索的时效筛选和低质量结果处理保留后续待办。页面布局、键盘、菜单/跳转和热点外链由用户验收，本轮未新增真实浏览器页面验收。全量恢复/回滚演练、代表性负载、运营平台/付费媒体及完整便携包继续保留既有边界；本次未发布安装器、未触碰其他项目服务。

## English

The quick entry successfully activated committed source `12f144c8` in isolation and then on live 138. Both environments use the same fixed image; 1,388 runtime source hashes match. HTTPS authentication, protected version/status APIs, official OpenClaw records and persistence checks passed. OpenClaw remains at 2026.9.6; the official latest query returns 2026.10.3.

The isolated/live Agent transcripts contain nine/eleven actual tool returns with no errors, covering skill reading, shell commands, search, fetch, browser and file writing. Real report downloads match server bytes. Frontend interaction acceptance belongs to the user. The Google News timeout display is now deployed, but its network reachability and RSS news freshness limitations remain explicit.
