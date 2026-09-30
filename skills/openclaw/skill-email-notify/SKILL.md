---
name: skill-email-notify
description: >-
  邮箱通知推送：生成/发布等任务完成后，把结果（状态+标题+产物/链接）发到用户邮箱，
  走 easel-notify MCP 的 notify_email 工具（或 scripts 兜底 mailer.py）。
  当用户说"邮箱通知""发邮件通知我""完成后发邮件""邮件提醒""生成完发我邮箱"
  "邮件推送结果"时使用。未配置邮箱时提示用户填 .env，不报裸错。
layer: publish
---

# 邮箱通知推送

> 任务完成后把结果发到用户邮箱。**优先走 easel-notify MCP 工具 `notify_email`**（已注册
> 进 easel profile）；MCP 不可用时兜底 `scripts/mailer.py`（纯标准库，同源发送核心）。
> 常与制作/发布串联：生成完成 → 邮件摘要；发布成功 → 邮件"已发布 + 标题 + 平台"。

## 前置：邮箱配置（项目根 .env）

| 变量 | 必填 | 说明 |
|------|------|------|
| `EASEL_NOTIFY_EMAIL` | 是 | 收件人，多个逗号分隔 |
| `EASEL_NOTIFY_SMTP_HOST` | 是 | 如 smtp.qq.com / smtp.163.com / smtp.exmail.qq.com |
| `EASEL_NOTIFY_SMTP_PORT` | 否 | 默认 465 |
| `EASEL_NOTIFY_SMTP_USER` | 否 | 认证账号（缺省=首个收件人） |
| `EASEL_NOTIFY_SMTP_PASS` | 视情况 | 密码/授权码（QQ/163 需开授权码，不是登录密码） |
| `EASEL_NOTIFY_SMTP_SSL` | 否 | 1（默认）=SSL(465)；0=STARTTLS(587) |

## 执行

先查状态，再发（或先 dry-run 预览）：

```bash
# MCP 工具（Agent 直接调用）
notify_email --subject "[Easel] 生成完成：《主题》" --body "状态 + 标题 + 产物"
notify_status            # 查脱敏配置与启用状态

# 兜底脚本（相对项目根）：skills/openclaw/skill-email-notify/scripts/mailer.py
python <skill>/scripts/mailer.py check --env-file .env
python <skill>/scripts/mailer.py send --subject "标题" --body "正文" --dry-run
```

## 规则

1. 发送前用 `notify_status` 或 `--dry-run` 确认配置与收件人，再真发。
2. SMTP 凭证从项目根 .env 读取，不写死、不外泄、不回显。
3. 通知内容简洁：状态 + 标题 + 平台/产物即可；正文只保留用户需要知道的信息。
4. QQ/163 个人邮箱必须用授权码（邮箱后台开），不是网页登录密码；认证失败如实提示。
5. 返回 ok:false 时把 detail 转述给用户；不重试轰炸（同任务 60s 内不重发）。

## 参考来源

RFC 5321/5322 标准 SMTP + EmailMessage（smtplib，纯标准库）。与
`mcp/easel-notify/mailer.py` 同一发送核心；web 完成钩子（对话收尾/一键发布）也走它。
