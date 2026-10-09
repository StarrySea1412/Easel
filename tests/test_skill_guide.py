"""小白版 SKILL 导读（web.app._skill_guide）定向测试。

对应 docs/secondary-development-plan.md 功能 B 的验收点：
- 抽样覆盖写作 / 图片 / 视频 / 发布类 SKILL；
- 原文缺字段有稳定回退（留空，前端显示「原文未说明」，不补造）；
- 示例逐字来自原文（不编造，可与真实脚本/命令对齐）；
- 纯静态提取：不需要模型或网络配置。

只读本地 SKILL.md，不调用真实小红书 / 模型服务。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "web"))

import app as web  # noqa: E402


def _guide(name: str, env: dict | None = None) -> dict:
    full = web.find_skill(name)
    assert full, f"技能不存在：{name}"
    p = web.SKILLS_DIR / "openclaw" / full / "SKILL.md"
    desc, _layer, body = web._parse_skill_md(p)
    return web._skill_guide(full, desc, body, p, env or {})


def _source(name: str) -> str:
    full = web.find_skill(name)
    return (web.SKILLS_DIR / "openclaw" / full / "SKILL.md").read_text(encoding="utf-8")


# ---- 抽样：写作 / 图片 / 视频 / 发布 ----

def test_guide_writing_skill():
    g = _guide("copywriting")
    assert "营销文案" in g["what"]
    assert "提炼卖点" in g["whenToUse"]
    assert any("文案类型" in x for x in g["needs"]["inputs"])
    assert g["whatYouGet"]
    assert g["howToStart"]


def test_guide_image_skill_marks_image_api():
    g = _guide("ai-image-gen", env={})
    assert g["what"].startswith("通用 AI 生图")
    assert g["needs"]["api"] and "生图" in g["needs"]["api"]["label"]
    assert g["needs"]["api"]["configured"] is False
    assert any(m["label"] == "AI 生图" and not m["configured"] for m in g["needs"]["media"])
    assert any("API 配置" in h for h in g["howToStart"])   # 未配置时给出填 Key 提示


def test_guide_image_api_configured():
    env = {"IMG_API_KEY": "sk-test", "IMG_BASE_URL": "https://example.com/v1", "IMG_MODEL": "fixture-image"}
    g = _guide("ai-image-gen", env=env)
    assert g["needs"]["api"]["configured"] is True
    assert all(m["configured"] for m in g["needs"]["media"])
    assert not any("API 配置" in h for h in g["howToStart"])


def test_chat_credentials_do_not_configure_workbench_image_or_video_channels():
    env = {'OPENAI_API_KEY': 'fixture', 'OPENAI_BASE_URL': 'https://fixture', 'IMG_MODEL': 'fixture-image'}
    assert not web._skill_api_configured('ai-image-gen', env)
    assert not web._guide_group_ready('image', env)
    assert not web._guide_group_ready('video', {**env, 'VIDEO_MODEL': 'fixture-video'})
    assert not web._skill_api_configured('ai-image-gen', {**env, 'IMG_API_KEY': 'dedicated'})
    assert web._skill_api_configured('ai-image-gen', {**env, 'IMG_API_KEY': 'dedicated', 'IMG_BASE_URL': 'https://image-fixture'})


def test_guide_video_skill():
    g = _guide("auto-subtitle")
    assert "字幕" in g["what"]
    assert "自动字幕" in g["whenToUse"]
    assert any("字幕" in x for x in g["whatYouGet"])


def test_guide_publish_skill_needs_account():
    g = _guide("skill-xhs-publisher")
    assert "小红书" in g["needs"]["accounts"]
    assert any("发布图文笔记" in t for t in g["whenToUse"])


# ---- 缺字段回退：不补造 ----

def test_guide_missing_sections_return_empty():
    g = _guide("skill-xhs-analyzer")
    assert g["whatYouGet"] == []          # 原文没有「输出」节
    assert g["needs"]["inputs"] == []
    assert g["needs"]["tools"] == ["redbook"]   # 来自 metadata.openclaw
    assert g["needs"]["os"] == ["macos"]


def test_guide_all_skills_smoke():
    """全部技能都能提取出结构稳定的导读（不抛异常、类型不变）。"""
    sd = web.SKILLS_DIR / "openclaw"
    count = 0
    for d in sorted(sd.iterdir()):
        p = d / "SKILL.md"
        if not p.is_file():
            continue
        count += 1
        desc, _layer, body = web._parse_skill_md(p)
        g = web._skill_guide(d.name, desc, body, p, env={})
        assert isinstance(g["what"], str)
        assert isinstance(g["needs"], dict)
        for key in ("whenToUse", "howToStart", "steps", "whatYouGet", "examples", "terms"):
            assert isinstance(g[key], list), (d.name, key)
    assert count > 100


# ---- 示例逐字来自原文（不编造） ----

@pytest.mark.parametrize("name", ["poster-hero", "copywriting", "auto-subtitle", "skill-xhs-publisher"])
def test_guide_examples_verbatim(name):
    src = _source(name).replace("\r\n", "\n")
    for ex in _guide(name)["examples"]:
        assert ex in src, f"{name} 的示例不在原文中：{ex}"


# ---- 端点返回 guide ----

def test_skill_detail_endpoint_returns_guide():
    d = asyncio.run(web.api_skill_detail("copywriting"))
    assert d["guide"]["what"]
    assert d["guide"]["needs"]["inputs"]


def test_skill_detail_endpoint_404():
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_skill_detail("nonexistent-xyz-000"))
