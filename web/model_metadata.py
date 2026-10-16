"""Small, sourced reference catalog. A reference is not relay entitlement.

Only exact identifiers match. Never infer a window from a family/prefix or
replace a user's configured budget on a read. Keep billing data out of it.
"""


def context_reference(model_id: str):
    if not isinstance(model_id, str) or model_id.lower() not in ('glm-5.3', 'z-ai/glm-5.3'):
        return None
    return dict(modelId=model_id, tokens=1_048_576, label='1M', source='智谱 GLM-5.3 文档',
                url='https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3',
                checkedAt='2026-10-16',
                note='原厂标称窗口；转发渠道、套餐或运行时配置可能另有限制。')
