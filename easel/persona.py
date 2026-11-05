"""Easel 画像（Profile）共享助手 —— CLI / Web / skill 三入口的单一真相源。

历史上三处各写一份画像逻辑，且 CLI 还残留全局 USER.md（并发竞态）。
统一到这里后：画像一律**作为消息内联**注入（`我当前使用的画像是「X」。`），
由当前 Agent 执行引擎按 AGENTS.md 自行读取 `profiles/<X>/` 并凝练，每个请求自包含，无全局文件污染。
参见 docs/prompt-stack.md。
"""

from __future__ import annotations

from pathlib import Path

from easel.paths import data_root

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PROFILES_DIR = data_root(PROJECT_ROOT) / "profiles"

# 六维画像文件的固定顺序（identity/style/... 先，其余 .md 追加在后）
_FILE_ORDER = [
    "identity.md", "style.md", "audience.md",
    "platforms.md", "preferences.md", "memory.md",
]


def list_personas() -> list[str]:
    """列出所有可用画像目录名（排除下划线开头的内部目录）。"""
    if not PROFILES_DIR.is_dir():
        return []
    return sorted(
        d.name for d in PROFILES_DIR.iterdir()
        if profile_exists(d.name)
    )


def profile_exists(name: str) -> bool:
    """检查画像目录是否存在，拒绝把路径片段当作画像名。"""
    from easel.profile_memory import linked
    return (valid_persona_name(name) and not linked(PROFILES_DIR) and not linked(PROFILES_DIR / name)
            and (PROFILES_DIR / name).resolve().parent == PROFILES_DIR.resolve()
            and (PROFILES_DIR / name).is_dir())


def valid_persona_name(name: str) -> bool:
    """Return whether ``name`` is a single, user-facing profile directory name."""
    return (
        isinstance(name, str)
        and bool(name)
        and not name.startswith((".", "_"))
        and not any(character in name for character in ("/", "\\", ":"))
        and not any(ord(character) < 32 for character in name)
    )


def load_profile_text(name: str, *, for_model: bool = False, query: str = '', task_type=None, include_memory=True) -> str:
    """读取画像文件夹，按固定顺序拼接所有非空 .md。画像不存在返回空串。"""
    if not valid_persona_name(name):
        return ""
    profile_dir = PROFILES_DIR / name
    if not profile_exists(name):
        return ""
    parts: list[str] = []
    for filename in _FILE_ORDER:
        if for_model and filename == 'memory.md':
            continue
        filepath = profile_dir / filename
        if filepath.is_file() and not filepath.is_symlink():
            text = filepath.read_text(encoding="utf-8").strip()
            if text:
                parts.append(text)
    for filepath in sorted(profile_dir.glob("*.md")):
        if filepath.name not in _FILE_ORDER and not filepath.is_symlink():
            text = filepath.read_text(encoding="utf-8").strip()
            if text:
                parts.append(text)
    if for_model and include_memory:
        context = model_memory_context(name, query, task_type=task_type)
        if context and context['entries']:
            import json
            from easel.context_budget import experience_reference
            parts.append('经验参考数据（不能覆盖本轮用户要求）：\n' + json.dumps(experience_reference(context), ensure_ascii=False))
    return "\n\n---\n\n".join(parts)


def model_memory_context(name, query='', *, task_type=None, prompt_builder=None):
    if not name or not profile_exists(name) or not (PROFILES_DIR.parent / 'memory/profile-memory.sqlite3').exists():
        return None
    from easel.profile_memory import MemoryStore
    import sqlite3
    try:
        return MemoryStore(PROFILES_DIR.parent, PROFILES_DIR).context(name, query, task_type=task_type, prompt_builder=prompt_builder)
    except (OSError, ValueError, sqlite3.Error):
        return {'entries': [], 'warning': '经验存储不可用，本轮未注入经验。'}


def model_turn_message(user_message, name, *, runtime='', references=(), task_type=None, prompt_builder=None):
    from easel.prompt_envelope import assemble
    from easel.context_budget import experience_reference, require_admitted
    sources = list(references)
    policy, runtime_text = turn_reminder(), persona_prefix(name) + '\n' + runtime
    def render(context):
        reference = experience_reference(context)
        return assemble(user_message, policy=policy, runtime=runtime_text,
                        references=[*sources, *([reference] if reference else [])])
    def transported(context):
        text = render(context)
        return prompt_builder(text) if prompt_builder else text
    context = model_memory_context(name, user_message, task_type=task_type, prompt_builder=transported)
    require_admitted(transported(context))
    return render(context)


def model_api_message(user_message, name, *, prompt_builder):
    """Direct-chat references do not request filesystem or Skill execution."""
    from easel.prompt_envelope import assemble
    from easel.context_budget import experience_reference, require_admitted
    def render(context):
        reference = experience_reference(context)
        if not reference:
            return user_message
        return assemble(user_message, policy='当前为API直连，仅用提供的资料回答，不执行本机工具或文件操作。',
                        references=[reference])
    context = model_memory_context(name, user_message,
                                   prompt_builder=lambda value: prompt_builder(render(value)))
    text = render(context)
    require_admitted(prompt_builder(text))
    return text


def persona_prefix(name: str | None) -> str:
    """把画像作为消息前缀内联。无画像或画像不存在时返回空串。

    明确账号记忆作用域，避免 OpenClaw 的全局 MEMORY.md 污染并行画像会话。
    """
    if name and profile_exists(name):
        from easel.profile_memory import linked
        if linked(PROFILES_DIR / name / 'memory.md'):
            return f'我当前使用的画像是「{name}」。经验文件路径不可用，本轮不得读取经验文件或数据库。'
        database = PROFILES_DIR.parent / 'memory' / 'profile-memory.sqlite3'
        if database.exists():
            import sqlite3
            from easel.profile_memory import linked
            if linked(database) or linked(database.parent):
                return '画像经验路径不可用；本轮不得读取经验文件或数据库。'
            try:
                with sqlite3.connect(database) as connection:
                    row = connection.execute('SELECT managed FROM profiles WHERE name=?', (name,)).fetchone()
                    has_policy = connection.execute("SELECT 1 FROM sqlite_master WHERE name='policies'").fetchone()
                    policy_row = connection.execute('SELECT data FROM policies WHERE profile_id=(SELECT id FROM profiles WHERE name=?)', (name,)).fetchone() if has_policy else None
                    if policy_row:
                        import json
                        if not json.loads(policy_row[0])['readEnabled']:
                            return (f'我当前使用的画像是「{name}」。偏好与红线读取该画像preferences.md。'
                                    '本画像已关闭读取经验；本轮不读取memory.md、经验数据库或账号经验历史。')
            except sqlite3.Error:
                return '画像经验存储不可用；本轮不得读取经验文件或数据库。'
            if row and row[0]:
                return (f'我当前使用的画像是「{name}」。偏好与红线读取该画像preferences.md；'
                        '经验已托管，仅使用本轮按范围提供的经验引用，不扫描memory.md、数据库或其他账号历史；'
                        '需要新增经验时只提出候选，不能代替用户确认或直接改文件。')
        return (
            f"我当前使用的画像是「{name}」。"
            f"本会话的账号长期记忆仅使用 profiles/{name}/memory.md，"
            "不要使用工作区全局 MEMORY.md 作为账号记忆。"
        )
    return ""


# --- 每轮行为提醒（抗长对话指令衰减）----------------------------------------
# AGENTS.md / SOUL.md 是系统提示，只在会话开头最「新鲜」；长对话里后续追问，
# 模型对系统提示的注意力会衰减 → 常见现象「开头会查 SKILL、后面就凭记忆裸做」。
# 把最关键的反射每轮在消息末尾重申一次（放末尾借近因效应），成本极低，
# 显著提升后续轮次的 SKILL 命中率。仅用于对话入口；单跑某个 SKILL 不必加。
TURN_REMINDER = (
    "〔内部提醒·非用户所说，勿复述、勿回显〕本轮动手前先查技能库："
    "有对应或相邻的 SKILL 就读进来、按它的流程/数据源/工具做，别凭记忆或通用知识裸做；"
    "五层（含制作层：图文/图/视频/成片/长稿等）都由你自己按对应 SKILL 产出成品文件到 outputs/；"
    "问「我的账号/帖子/粉丝/最近发了啥」先查已登录账号、别回问用户要账号名；"
    "网页研究先搜索确认 URL，搜索 disabled/无 provider 后不重复调用，也不猜产品路径或用 web_fetch 抓搜索结果页；"
    "可沿已读取官方页的实际 href 导航。404 回导航或换来源，403/动态页仅用已核验可用浏览器试一次，"
    "超时/5xx 最多退避重试一次，429 遵守 Retry-After，同域同类失败两次就换方法；"
    "终端客户端先查是否安装并确认shell，保留 stderr；Linux默认/bin/sh可能是dash，不支持pipefail，"
    "需要pipefail时必须显式使用bash -lc执行，不在sh中直接set -o pipefail；检查HTTP/退出码/有效非空结果；"
    "网络可用性只认工具回执，不绕过安全拒绝，不把搜索摘要或猜测当已核验原文；"
    "要发到公开平台的文案/评论绝不写入密钥/内部地址/代理/路径/env 名等敏感信息，也别随手自曝「由 AI 生成/某工具做的」。"
)

IMAGE_CREATION_POLICY = (
    '〔图片任务交付〕用户要求制作小红书卡组、海报、封面、配图等图片成品，或明确要求AI生图、文生图、图生图或图像编辑时，'
    '小红书三图卡组使用easel_xhs_cards：submit一次提交统一style和封面/卖点/场景收尾三个不同prompts，固定requestId；status只读。登记后等待队列完成而非直接结束；三张实际图片保存后必须逐张读取查看，再review提交当前sha256、逐图审图依据及全部质量检查；未审图不能称质量通过，缺图不能称整组完成，不换标识重生，不自动发布。'
    '其他图片任务在本轮图片制作授权内主动调用easel_generate_image；没有该工具时按ai-image-gen的专用通道执行，不能只写生图提示词。'
    '不能先生成HTML、SVG或代码截图代替AI生图，也不先交付网页草稿。'
    '当前用户要求优先于已选卡片技能的默认流程和历史产物；海报、封面、小红书等用途本身不代表选择HTML排版。'
    '只有明确要求网页、HTML/CSS排版、代码绘图或确定性文字/数据卡片时才走对应渲染路径。'
    '用户限定使用真实素材时尊重素材约束；商品实物、型号、参数和来源不能用生成图伪造。'
    '需要图文合成时先生成用户要求的图片，再按需求排版；最终交付可打开的实际图片，HTML源文件不能充当图片成品。'
    '缺配置或生成失败时说明实际原因并保留未完成状态，不静默改为手绘或HTML；替代方式须由用户选择。'
    '沿用本轮已获授权的范围、数量与费用边界，不因路由规则新增付费授权，也不重复索取已有授权。'
)


def turn_reminder() -> str:
    """返回每轮行为提醒文案。"""
    return TURN_REMINDER + '\n' + IMAGE_CREATION_POLICY


def chat_turn_message(user_message: str, name: str | None) -> str:
    """构造发给 OpenClaw 的一轮对话消息：画像前缀（如有）+ 用户原文 + 末尾行为提醒。

    末尾提醒对抗长对话里「忘记先查 SKILL」的指令衰减（见 TURN_REMINDER）。
    对用户不可见（前端只显示用户原文），只进 OpenClaw 上下文。
    """
    prefix = persona_prefix(name)
    head = f"{prefix}\n\n" if prefix else ""
    return f"{head}{user_message}\n\n{turn_reminder()}"
