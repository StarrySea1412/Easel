"""Compatibility exports for the shared local context estimator."""
from easel.context_budget import (
    DEFAULT_PROMPT_BUDGET, DEFAULT_FIXED_RESERVE, MIN_PROMPT_BUDGET,
    MAX_PROMPT_BUDGET, PromptAdmission, admit, estimate_tokens,
    prompt_budget, fixed_reserve,
)


LONG_TASK_OUTPUT_RULE = (
    "〔长任务输出边界〕需要生成大量文字、代码、卡片或多个文件时，先分批写入 "
    "outputs/主题目录并逐批校验，再在聊天中给简短摘要和真实文件链接；每轮只完成一小批可验证步骤。"
    "接近单次输出上限时主动收尾并说明下一步，不要把完整长产物一次性塞进单条回复。"
)
