# Easel 138 正式发布回执 · 0.45.9 · 2026-11-03

## 目标与修复

138问题`63eafc65f6d258cbb204919d55ed8474`发生在旧版0.45.5。MiniMax-M3单轮输出到8192 tokens后以原生`stopReason=length`结束，Gateway只传泛化`failed`，导致Easel没有进入自动继续判断。0.45.9从当前对话轮次的原生轨迹恢复终止原因；用户启用自动继续且本轮无工具操作、审计完整、无待确认或停止时，在同一会话使用新幂等ID最多接续2次，不重发原请求。有工具副作用时停止自动接续并保留正文。

## 激活身份与备份

- 产品版本：`0.45.9`
- 固定源码提交：`7688c07db8f5cc88fc7452a31014cc7aa2011a3a`
- 发行包：2,291个源码文件，SHA-256 `eb08fe789c642d143bb906e790e16212a974332131533b106acbdfb79ed12fcf`
- 正式镜像：`easel:7688c07db8f5`，image ID `sha256:68d062a55d2466dc33733b22ab6ec5ee7fd273968695010bcd0d60a811f5f59a`
- 激活路径：`/home/ubuntu/Easel` → `/home/ubuntu/easel-releases/Easel-138-7688c07db8f5`
- 停写备份：`/home/ubuntu/easel-backups/20261103T063733Z.tar.gz`，770,247,654 bytes
- 已保留前一发布：`/home/ubuntu/easel-releases/Easel-138-747adfea1933`；代码回退使用当前发布管理器的`manage.py rollback`。备份数据恢复是独立操作。
- Docker构建复用旧固定运行时镜像`sha256:dfa477833b46a96bc72b62ee1b6dbb648347e92c1647c7da017069c7bf55a584`，在同一候选中重建应用源码及前端；依赖输入一致。发布前磁盘可用24,683,597,824 bytes。

## 内部验收

- 隔离与正式实例均以测试管理员`gaojitest`登录成功；匿名`/api/version`返回401，认证后返回0.45.9、完整提交SHA、`development=false`及`Cache-Control: no-store`。
- 正式HTTPS首页和登录探针返回200；认证`/api/status`返回Gateway ready、runtime `openclaw`。
- 正式app及browser使用同一镜像，均healthy且重启数为0。
- 容器内`verify_runtime.py`确认1,751个运行源码文件与发行清单匹配；70个实际通过HTTPS提供的JS/CSS文件逐个与容器SHA-256匹配，共4,611,429 bytes，无缺失或不一致。
- 本机相关后端测试231项通过；错误展示前端测试41项通过；前端生产构建通过，lint通过并保留既有warning。全量前端套件跑至378项后因其包含无关长时测试而主动中止，不计为全量通过。
- 内部验收通过HTTP/API和自动化测试完成，没有操作用户电脑或浏览器。

## 尚未验证

没有调用真实模型，也没有重放问题`63eafc65`或发送长提示制造触顶。回归覆盖原生`length`轨迹、空/部分正文、同会话有界接续、幂等ID、用户停止、审计不完整和工具副作用阻止重复派发；这证明代码路径及运行版本已更新，不代表MiniMax实时可用性、真实续接质量或长期生产成功率已经建立。安装器未发布。
