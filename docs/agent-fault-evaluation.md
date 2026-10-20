# Agent 确定性故障回归报告

从已有 pytest 的 JUnit XML 生成可比较的 JSON 证据，不运行模型、不调用平台、不重放工具。
首批三个场景覆盖原生会话身份恢复、并发会话所有权与取消清理、原生致命错误通知。
场景 ID、故障阶段、预期行为、禁止效果及具体测试映射位于报告脚本的 `SCENARIOS`。

```bash
python -m pytest -q tests/test_agent_harnesses.py --junitxml=agent-tests.xml
python scripts/agent_fault_report.py agent-tests.xml --revision YOUR_TESTED_COMMIT > agent-report.json
```

测试命令失败时也可以生成报告，但必须保留 pytest 的退出码与原始 XML；生成报告不改变测试结果。
报告命令退出码：0 表示三个登记场景全部通过，1 表示至少一个失败、错误、跳过或未运行，
2 表示输入文件不可读取或格式无效。0 只覆盖登记场景，不代表整个测试套件或产品全部通过。
部分测试文件、`-k` 筛选或测试更名可能产生 `not_run`，不会被当成成功。

输出包含输入 XML 的 SHA-256、调用者提供的版本标签及每个场景的结果与测试用时。
版本标签不被脚本独立验证；应由执行测试的 CI 记录当时的提交，而不是事后猜测。
失败堆栈、stdout/stderr、测试参数值和工具输出不会复制进报告。原始 XML 仍需妥善保管。

`test_duration_seconds` 是关联测试的执行用时，不等于任务恢复延迟。
模型调用数、重复外部效果数及恢复延迟目前没有独立采集，明确输出 `null`，不伪装成零。
测试断言通过也不等于真实用户任务成功率。相同 XML 和版本标签会生成相同报告。

待任务账本、检查点及调用预算功能合入后，再分小 PR 登记对应场景、采集专门指标，
并接入 CI artifact。真实模型任务评测需要独立的任务集、费用预算和多次采样，当前命令不提供。
