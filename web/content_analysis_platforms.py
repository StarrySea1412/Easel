"""Transparent platform editorial lenses, never claims about recommendation algorithms."""
from copy import deepcopy

VERSION = '2026-10-08'
# Each rule requires actual supplied text before it can create a diagnostic.
_RULES = {
    'xiaohongshu': ('小红书', [('body', '搜索问题与收藏用途', '检查正文是否给出可检索的具体问题、适用条件和方便保存后照做的步骤。'), ('comments', '笔记评论中的使用需求', '把真实评论里的使用情境整理成补充说明，保留条件与例外，不外推搜索需求规模。')]),
    'bilibili': ('B站', [('transcript', '长视频承诺与论证', '对照标题逐段标出问题、演示和结论，检查开场承诺是否有文字证据兑现。'), ('comments', '系列内容与观众追问', '从真实追问整理后续解释或系列候选，先核对本篇是否已回答。')]),
    'douyin': ('抖音', [('transcript', '短视频开场与信息推进', '检查开场是否说清对象与问题，标记重复表达和需要演示的句子，交给人工对照实际视频。'), ('coverText', '短视频封面承诺', '核对封面文字提出的承诺与逐字稿交付，不以文案推断点击或完播表现。')]),
    'kuaishou': ('快手', [('transcript', '情境说明与经验边界', '检查口播是否交代实际使用情境、操作过程及经验适用范围，保留可核验细节。'), ('comments', '使用追问与回应', '选择真实评论中的操作疑问，补充可执行答复和适用条件。')]),
    'zhihu': ('知乎', [('body', '问题回应与论证来源', '人工对照实际问题，检查正文是否直接回应、区分事实与观点，并为核心论点补来源和反例边界。'), ('comments', '论证质疑与澄清', '区分真实评论中的质疑、反例和补充材料，再检查正文是否需要澄清。')]),
    'wechat-oa': ('公众号', [('body', '标题交付与长文结构', '对照标题检查正文服务的读者、段落论证和结尾，写明适用对象与信息来源。'), ('comments', '读者回应与转发情境', '根据实际评论识别读者问题，提出可验证的分享情境假设，不把留言当成转发原因。')]),
    'weixin-channels': ('视频号', [('transcript', '分享对象与口播交付', '检查口播能否说明适合什么人、解决什么问题，提出待验证的分享情境。'), ('comments', '社交情境中的追问', '仅根据已提供评论补充适用情境与答复，不推断好友关系或传播路径。')]),
}


def platform_profile(platform):
    label, rules = _RULES[platform]
    return deepcopy({'platform': platform, 'label': label, 'version': VERSION,
        'focus': [rule[1] for rule in rules],
        'materialNeeds': list(dict.fromkeys({'body': '实际正文', 'transcript': '实际逐字稿', 'comments': '真实评论', 'coverText': '封面文字/OCR'}[rule[0]] for rule in rules)),
        'limitations': ['平台视角是公开可解释的编辑检查方向，不是推荐算法规则或效果归因。', '只检查已提供文字；未读取实际画面、音频、留存曲线或外部问题页面。', '播放、阅读、分享等指标需核对原始口径；不跨平台排名，不把缺失补零。']})


def platform_diagnostics(platform, content):
    result = []
    for field, dimension, action in _RULES[platform][1]:
        value = content.get(field)
        if field == 'comments':
            value = '\n'.join(value or [])
        if not value or not any(char.isalnum() for char in value):
            continue
        result.append({'id': f'{content["id"]}:platform-{field}', 'dimension': f'{_RULES[platform][0]} · {dimension}',
            'observation': f'已提供相关文字，可开展“{dimension}”编辑核对；尚未验证实际传播效果。',
            'evidence': value[:400], 'action': action,
            'limitation': '这是平台情境下的文字编辑视角，不代表算法偏好；未提供材料不作判断。'})
    return result
