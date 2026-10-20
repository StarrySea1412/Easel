# Linux对话请求 TypeError · 2026-10-20

## 诊断

0.7.3修复登录状态和流续接后，138仍有重复对话失败。服务器失败回执记录`POST /api/chat/stream`以500结束，异常类型`TypeError`，栈定位到`easel/plan_progress.py:68`；随后同一时间出现`GET /api/chat/jobs/{turn_id}/stream`的404。直接在0.7.3运行容器调用`instructions()`可以稳定复现：Linux `shlex.quote`收到`PosixPath`，抛出“expected string or bytes-like object, got 'PosixPath'”。

规划提示在OpenClaw消息构造时无条件拼接，所以这个平台类型错误会影响每一条新的OpenClaw对话，在模型请求之前返回500。流恢复随后查询不存在的任务账本，因此给用户看到了“对话任务记录不存在或已失效”。这次404不是模型推理失败；之前只补客户端恢复逻辑，没有修复首个500，是上次诊断的遗漏。

## 修复

对PowerShell与POSIX命令的参数引用统一先转为字符串，保留各自已有的引用规则；添加路径对象（含空格）的POSIX回归测试。业务版本从0.7.3 patch递增至0.7.4。部署后需直接验证规划提示函数、认证HTTP chat-stream正常进入流式响应，再由用户决定是否发起真实模型请求；不自动重发历史任务。

## 138验证回执

待部署后填写源码提交、镜像、隔离/正式实例、HTTP请求与运行文件校验结果。真实付费模型响应、历史对话是否能找回仍需单独核验，不以入口正常或返回SSE头代替。
