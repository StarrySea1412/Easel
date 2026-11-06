# AIHub渠道与思考强度（0.46.9候选）

日期：2026-11-06

138最终仅保留一个聊天provider`aihub`、一个模型`gpt-6.1-sol`和一个端点`https://aihub.top/v1`，没有备用provider或fallback。Kimi模型和`.dog`优化端点已从provider与只读启动模板移除。Polo生图仍使用`https://polocn.580ai.net/v1`及Sunburst默认模型，Flare按需选择。

## 设置页渠道数量

138 `/api/settings/models` 当前列出6类渠道、17个外部provider选项：chat 1、transcribe 1、image 1、video 7、music 2、speech 5。另有一个内置字幕解析入口，不需provider。当前已配置2/17个外部provider（AIHub聊天、Polo生图）；另15项未配置。SiliconFlow转写缺Key，视频7项、音乐2项、语音5项都未配置。GPT聊天模型未经能力核验，不复制填入其它媒体渠道。

## 思考强度

在用户提供的同一Key下，两个端点的`/v1/models`均返回HTTP 200并列出`gpt-6.1-sol`。最小Chat Completions请求显示：`low`、`medium`、`high`、`xhigh`、`max`均返回HTTP 200；`minimal`返回HTTP 400。对各档的小额回复没有可用的reasoning-token统计，也没有要求供应商输出私有思维链。因此结果表示这些请求参数被端点接受，不代表已测得真实内部推理预算或可见思考内容。

138通道模型元数据只声明已探测的五档。当前前端偏好为“自适应最高”，故按其选择规则最高支持档为`max`；用户也可切换四个其它已验证档。`minimal`不列入选项。后端保留能力缺失时不猜测支持范围。

## 实现与验证

- `web/office_controls.py`从模型自身`compat.supportedReasoningEfforts`提取允许的标准强度并过滤未知值；通用模型选择接口可据此向UI提供精确选项。
- `tests/test_model_config_reliability.py`新增隔离测试，确认只公开模型显式声明且项目认识的选项。该文件69项通过。
- 纠正前配置备份：`/home/ubuntu/easel-secrets/config-backups/20261106T032038Z-aihub-channel-cutover`。单渠道收敛前另备份：`/home/ubuntu/easel-secrets/config-backups/20261106T035351Z-single-aihub`。只读运行API返回1个选项`aihub · gpt-6.1-sol`，设置API返回chat 1行、Polo image 1行；Polo基础地址/模型不变。启动模板现只有`aihub`。未重启容器。
- 运行中的0.46.6能力API暂未返回强度列表，因为0.46.9元数据映射尚未部署；因此选择器强度UI仍未正式验收。
- 新源码版本0.46.9，未部署到138；未重启容器。正式代码仍0.46.6。此文档没有验证失败时OpenClaw fallback的真实业务表现，也没有测供应商推理token。

后续需要部署0.46.9候选并在真实浏览器确认单模型与强度滑杆显示及`max`默认选择。仅有一个AIHub端点，无故障fallback。生图超时修复、三图质量试验与可见思考/执行时间线仍按主任务清单待办。
