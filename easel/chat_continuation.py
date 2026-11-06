"""Bounded continuation decisions; never replay an uncertain request."""
import re
import hashlib
import unicodedata

MAX_CONTINUATIONS = 2
NO_PROGRESS_ERROR = 'Easel continuation stopped: repeated output without progress.'
DEADLINE_ERROR = 'Easel continuation stopped: total deadline exhausted.'
OUTPUT_LIMIT_REASONS = frozenset({'length', 'max_tokens', 'max_output_tokens', 'model_length'})
SAFE_TERMINAL_OPERATION_STATUSES = frozenset({'completed', 'returned'})
CONTINUE_MESSAGE = (
    '〔Easel自动继续：原轮次已经结束，本次是同会话的接续请求〕'
    '继续完成用户尚未完成的任务。先核对上轮工具回执、已有文件和任务状态，'
    '从断点继续，不重发原任务、不重复提交生成/发布/支付/上传等已有操作；'
    '已有任务先查询原requestId。保持原授权和确认边界，缺材料或权限时明确提问并停止。'
    '工具失败先修正原因；图片能力不可用时明确说明，禁止用像素统计或ASCII猜图冒充看图。'
    '完成后核对实际产物和未完成项，不要只承诺稍后执行。'
)


def progress_fingerprint(text):
    """Only detect identical visible content, not claimed task completion."""
    normalized = re.sub(r'\s+', '', unicodedata.normalize('NFKC', text)).casefold()
    return hashlib.sha256(normalized.encode('utf-8')).hexdigest() if normalized else None


def continuation_reason(*, error='', stop_reason=None, text='', plan=(), operations=(), pending_question=False,
                        continuation_index=0):
    if continuation_index >= MAX_CONTINUATIONS:
        return None
    if pending_question:
        return None
    # A model continuation can repeat a completed external action. Keep the
    # automatic path text-only; turns with any tool operation need review.
    if operations:
        return None
    if re.search(r'确认|授权|验证码|登录|缺少材料|请提供|是否需要|是否继续|\?|？', text[-1200:]):
        return None
    # A terminal output-limit receipt is stronger than Gateway's generic
    # failed summary; only resume after the exact run has reached a terminal.
    if stop_reason in OUTPUT_LIMIT_REASONS:
        return 'output_limit'
    if error:
        return 'model_idle_timeout' if re.search(r'LLM idle timeout\s*\(\d+s\)', error, re.I) else None
    unfinished = any(step.get('status') in ('pending', 'in_progress', 'inProgress') for step in plan)
    promise = re.search(r'(?:我会|接下来|下面将|现在开始|I will|I’ll|Next,? I)', text, re.I)
    if unfinished and promise and len(text) < 1200:
        return 'unfinished_plan'
    return None


def confirmed_terminal_operations(receipt):
    """Return tool receipts only when the transcript audit is complete."""
    if (not isinstance(receipt, dict) or receipt.get('warnings')
            or not isinstance(receipt.get('operations'), list)):
        return None
    operations = receipt['operations']
    if any(not isinstance(row, dict) or row.get('status') not in SAFE_TERMINAL_OPERATION_STATUSES
           for row in operations):
        return None
    return operations
