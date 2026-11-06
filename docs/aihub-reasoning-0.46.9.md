# AIHub渠道与思考强度（0.46.9候选）

日期：2026-11-06

138运行设置已直接更新并备份。对话主模型为`aihub/gpt-6.1-sol`，默认端点`https://aihub.top/v1`；OpenClaw备用模型为`aihub-opt/gpt-6.1-sol`，地址`https://aihub.dog/v1`。停止使用Kimi。Polo生图通道仍为`https://polocn.580ai.net/v1`及原Sunburst默认模型，Flare仍按需选择。

这次保留两个自定义提供商标识，是为了让OpenClaw的模型fallback能在主端点失败时选择优化端点。模型选择器渠道名为`aihub`和`aihub优化端点`。它不构成供应商侧自动切换可用性保证；需要实际故障场景的安全验收后才能称稳定回退。

## 思考强度

在用户提供的同一Key下，两个端点的`/v1/models`均返回HTTP 200并列出`gpt-6.1-sol`。最小Chat Completions请求显示：`low`、`medium`、`high`、`xhigh`、`max`均返回HTTP 200；`minimal`返回HTTP 400。对各档的小额回复没有可用的reasoning-token统计，也没有要求供应商输出私有思维链。因此结果表示这些请求参数被端点接受，不代表已测得真实内部推理预算或可见思考内容。

138通道模型元数据只声明已探测的五档。当前前端偏好为“自适应最高”，故按其选择规则最高支持档为`max`；用户也可切换四个其它已验证档。`minimal`不列入选项。后端保留能力缺失时不猜测支持范围。

## 实现与验证

- `web/office_controls.py`从模型自身`compat.supportedReasoningEfforts`提取允许的标准强度并过滤未知值；通用模型选择接口可据此向UI提供精确选项。
- `tests/test_model_config_reliability.py`新增隔离测试，确认只公开模型显式声明且项目认识的选项。该文件69项通过。
- 138变更前备份：`/home/ubuntu/easel-secrets/config-backups/20261106T032038Z-aihub-channel-cutover`。运行的OpenClaw配置及`/run/secrets/model-bootstrap.json`均包含主/备AIHub模型；应用配置文件已恢复为UID/GID 1000可读写。容器只读回执确认provider仅`aihub`、`aihub-opt`；HTTP能力接口确认默认主模型`aihub/gpt-6.1-sol`。Polo基础地址与模型名一致。
- 真实会话能力端点返回两个选项，主模型显示`aihub · gpt-6.1-sol`。后端参数列表在0.46.6运行代码中仍为null，因为此项新的本地元数据映射尚未部署；UI强度选择尚未正式验收。
- 新源码版本0.46.9，未部署到138；未重启容器。正式代码仍0.46.6。此文档没有验证失败时OpenClaw fallback的真实业务表现，也没有测供应商推理token。

后续需要部署0.46.9候选并在真实浏览器确认强度滑杆显示及`max`默认选择，再做不重放历史轮次的主端点故障/备用路由验证。生图超时修复、三图质量试验与可见思考/执行时间线仍按主任务清单待办。
