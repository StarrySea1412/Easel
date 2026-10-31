# 138 提问卡片修复与发行切换兼容候选 0.43.8

## 当前问题

用户在 138 仍看不到 `ask_user` 问题卡片。0.43.6 问答桥接修复还没有进入正式环境。闲置盘迁移后，旧发行目录由 root 保护，导致 0.43.7 先后在构建基线读取和隔离切换读取旧回执时受阻。

0.43.7 镜像已完整构建，固定 revision 为 `80d88b7937292c03ba7e3156d321b7140de17ca3`；切换在停写备份后失败，随后已把隔离 app/browser/proxy 恢复到原 `easel:356b80ab72a4`，三者 healthy。正式 8444 未切换。

## 0.43.8 修复

- 构建基线回执不可读时，从生产部署配置、固定镜像和实际 app 容器交叉核验后读取镜像内发行清单。
- 激活前先捕获旧发行身份，再停写备份和写入候选配置。旧回执不可读时，依据原部署环境和旧 app 容器 image ID/revision 重建回滚收据；不改旧发行权限，也不让新镜像配置覆盖回滚目标。
- 回退前验证固定镜像、manifest 和 revision 一致；用当前可读发行的 Compose/nginx/seccomp 控制文件启动旧固定镜像，避免读取 root-only 旧目录。
- 保留 0.43.6 的 Gateway 凭据问答桥接和待答问题卡片修复。

## 验证与剩余门槛

- 本地发布专项：`tests/test_linux_release.py` 22 项通过；`deployment/138` Python 编译和 `git diff --check` 通过。
- 固定提交 `2928ab7a75d8d9150885c72e33648cf84205dc82` 已构建并激活到隔离 8445；app/browser/proxy 均 healthy，HTTPS 登录探测通过，停写快照为 `/home/ubuntu/easel-backups-test/20261030T131108Z.tar.gz`。
- 隔离认证 HTTP 登录成功，版本接口返回 `0.43.8` / revision `2928ab7a75d8d9150885c72e33648cf84205dc82`。使用合成提示和 `happycoding/deepseek-v4.1-flash` 的隔离问答实测收到完整 `question` SSE，`/api/chat/question/answer` 成功提交选项，随后收到 `done`；未重放用户原任务。
- 初次本机浏览器通过 SSH 隧道访问隔离站点报告 `ERR_CERT_AUTHORITY_INVALID`，未点击绕过警告。随后重新绑定现有标签时登录页已可用，完成隔离测试账号真实登录与问答：页面出现 A/B 卡片，点击 A 并提交后显示 `status: answered` 与“问答卡片验收通过”，运行中计数归零（会话 `mvv0ns99snkls1`，轮次 `1793367565341-4ro62gcx2oa`）。因此卡片显示及回答闭环已通过；期间工具行仍写“执行中”，等待状态遗漏转入0.43.9修复。截图仅有工具返回，未保存独立文件。
- 正式 8444 尚未切换。切换前备份被旧 root-owned 0.43.3 release 的 `compose.yaml` 读取权限阻断；Compose 在停止 app 前即失败，8444 保持健康且未中断。0.43.8 已解决构建基线、隔离激活与回滚的旧目录读取问题，但停写备份仍漏用候选控制文件；先补回归并修正此路径，再重验隔离和正式切换。
- 已修正：停写备份改用当前已校验发行的 Compose 控制文件，并增加旧发行受保护场景回归。`tests/test_linux_release.py` 24 项通过，发布脚本 Python 编译及 `git diff --check` 通过；该补丁尚未提交，也尚未在 138 新 SHA 隔离复验。
- 当前运行状态：隔离仍是 `2928ab7a75d8d9150885c72e33648cf84205dc82`，正式仍是历史 `de1f388d0042` / 0.43.3。正式首次尝试在 app 停止前失败，健康、历史重启计数及 `gateway.reload.mode=off` 未变。
- 正式切换成功后，保留停写备份和回滚入口；源码、远端SHA、镜像、运行版本及正式页面分别留证。
- malformed tool-call、视觉输入、跨设备对话同步和完整 0.44 大版本继续单独推进。
