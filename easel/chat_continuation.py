"""Bounded continuation decisions; never replay an uncertain request."""
import re

MAX_CONTINUATIONS = 2
CONTINUE_MESSAGE = (
    '〔Easel自动继续：原轮次已经结束，本次是同会话的接续请求〕'
    '继续完成用户尚未完成的任务。先核对上轮工具回执、已有文件和任务状态，'
    '从断点继续，不重发原任务、不重复提交生成/发布/支付/上传等已有操作；'
    '已有任务先查询原requestId。保持原授权和确认边界，缺材料或权限时明确提问并停止。'
    '工具失败先修正原因；图片能力不可用时明确说明，禁止用像素统计或ASCII猜图冒充看图。'
    '完成后核对实际产物和未完成项，不要只承诺稍后执行。'
)


def continuation_reason(*, error='', stop_reason=None, text='', plan=(), operations=(), pending_question=False):
    if pending_question:
        return None
    # Permission/approval and non-idempotent pending work need human review.
    if any(row.get('status') in ('running', 'unconfirmed', 'denied', 'stopped') for row in operations):
        return None
    if re.search(r'确认|授权|验证码|登录|缺少材料|请提供|是否需要|是否继续|\?|？', text[-1200:]):
        return None
    if error:
        return 'model_idle_timeout' if re.search(r'LLM idle timeout\s*\(\d+s\)', error, re.I) else None
    if stop_reason in ('length', 'max_tokens', 'max_output_tokens'):
        return 'output_limit'
    unfinished = any(step.get('status') in ('pending', 'in_progress', 'inProgress') for step in plan)
    promise = re.search(r'(?:我会|接下来|下面将|现在开始|I will|I’ll|Next,? I)', text, re.I)
    if unfinished and promise and len(text) < 1200:
        return 'unfinished_plan'
    return None
