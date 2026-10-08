"""Offline publishing receipts: platform results, links, and calendar side effects.

Browser/API objects are fakes; these tests do not log in, publish, or notify.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills" / "shared" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "openclaw" / "skill-bilibili-upload" / "scripts"))

import bili_upload as bili
import calendar_ops
import douyin_publish as dy
import platform_readback as rb
import publish_receipt as receipts
import web_publisher as wp
import weixin_mp_stats as mp
import xhs_publish as xhs

RID = "12" * 16
DOUYIN_ID = "7390123456789012345"
KUAISHOU_ID = "3xci4crvz493enm"
BVID = "BV18JgA6pEnA"


@pytest.fixture(autouse=True)
def receipt_environment(monkeypatch):
    monkeypatch.setenv("EASEL_PUBLISH_RECEIPT_ID", RID)
    monkeypatch.setenv("EASEL_CALENDAR_AUTORECORD", "0")
    monkeypatch.setenv("EASEL_PACE_SKIP", "1")


def read_receipt(capsys):
    lines = capsys.readouterr().out.splitlines()
    assert all(line.isascii() for line in lines if line.startswith(receipts.PREFIX))
    rows = [json.loads(line[len(receipts.PREFIX):]) for line in lines if line.startswith(receipts.PREFIX)]
    assert len(rows) == 1
    assert rows[0]["schemaVersion"] == 1 and rows[0]["receiptId"] == RID
    return rows[0]


def verdict(status, content_id=DOUYIN_ID):
    return rb.ReadbackResult("verified", rb.WorkItem(content_id, "回执测试", status),
                             evidence={"raw": "https://example.test/?token=never-forward-this"})


@pytest.mark.parametrize("status,outcome", [
    ("published", "published"), ("已发布", "published"),
    ("reviewing", "submitted"), ("scheduled", "submitted"), ("审核中", "submitted"),
    ("private", "unverified"), ("仅自己可见", "unverified"),
    ("rejected", "failed"), ("deleted", "failed"),
    ("", "unverified"), ("0", "unverified"), ("unrecognized", "unverified"),
])
def test_matched_work_is_not_automatically_published(status, outcome):
    row = receipts.from_readback("douyin", verdict(status))
    assert row["outcome"] == outcome
    assert bool(row["url"]) is (outcome == "published")
    assert "never-forward-this" not in json.dumps(row)
    assert row["evidence"]["publicAccessChecked"] is False


@pytest.mark.parametrize("outcome", ["unverified", "login_required", "readback_error"])
def test_failed_readback_preserves_uncertainty(outcome):
    row = receipts.from_readback("douyin", rb.ReadbackResult(outcome, error="token=secret"))
    assert row["outcome"] == "unverified" and not row["url"]
    assert "secret" not in json.dumps(row)


@pytest.mark.parametrize("raw", [None, {}, "published", "unexpected", 0, {"is_private": False}])
def test_missing_or_unknown_douyin_status_cannot_become_public(raw):
    status = rb._normalize_douyin_status(raw, None)
    assert receipts.from_readback("douyin", verdict(status))["outcome"] == "unverified"


def test_explicit_douyin_public_flags_and_nonpublic_overrides():
    flags = dict(is_delete=False, is_prohibited=False, in_reviewing=False, is_private=False)
    assert rb._normalize_douyin_status(flags, 1) == "published"
    assert rb._normalize_douyin_status({**flags, "is_private": True}, 1) == "private"
    assert rb._normalize_douyin_status({**flags, "in_reviewing": True}, 1) == "reviewing"
    assert rb._normalize_douyin_status(flags, 99_999_999_999) == "scheduled"


@pytest.mark.parametrize("timestamp", [None, 0, -1, True, False, "1791421200000", "bad", 1.5, float("nan"), float("inf")])
def test_current_publish_match_requires_valid_millisecond_evidence(timestamp, monkeypatch):
    started = 1_791_421_200_000
    monkeypatch.setattr(rb.time, "time", lambda: started / 1000)
    work = rb.WorkItem(DOUYIN_ID, "本次同标题作品", "published", timestamp)
    assert rb.find_published_work([work], work.title, since_ms=started, exclude_ids=set()) is None
    # A standalone historical title lookup is not a claim about a fresh publish.
    assert rb.find_published_work([work], work.title) is work


@pytest.mark.parametrize("since", [0, -1, True, "1791421200000", float("nan"), float("inf")])
def test_invalid_publish_start_does_not_disable_the_time_requirement(since):
    work = rb.WorkItem(DOUYIN_ID, "时间证据测试", "published", 1_791_421_200_000)
    assert rb.find_published_work([work], work.title, since_ms=since) is None


def test_publish_time_window_rejects_old_and_impossible_future_work(monkeypatch):
    started = 1_791_421_200_000
    monkeypatch.setattr(rb.time, "time", lambda: started / 1000)
    old = rb.WorkItem("old", "边界相同标题", "published", started - rb.SINCE_TOLERANCE_MS - 1)
    future = rb.WorkItem("future", old.title, "published", started + rb.SINCE_TOLERANCE_MS + 1)
    boundary = rb.WorkItem("boundary", old.title, "published", started - rb.SINCE_TOLERANCE_MS)
    assert rb.find_published_work([old, future], old.title, since_ms=started, exclude_ids={"preexisting"}) is None
    assert rb.find_published_work([old, boundary, future], old.title, since_ms=started, exclude_ids={"preexisting"}) is boundary


@pytest.mark.parametrize("snapshot", [None, set()])
def test_no_snapshot_cannot_match_a_five_minute_old_public_work(snapshot, monkeypatch):
    started = 1_791_421_200_000
    monkeypatch.setattr(rb.time, "time", lambda: started / 1000)
    old = rb.WorkItem(DOUYIN_ID, "同标题旧作品", "published", started - 5 * 60 * 1000)
    assert rb.find_published_work([old], old.title, since_ms=started, exclude_ids=snapshot) is None


def test_no_snapshot_allows_only_one_second_timestamp_precision(monkeypatch):
    started = 1_791_421_200_555
    monkeypatch.setattr(rb.time, "time", lambda: started / 1000)
    same_second = rb.WorkItem(DOUYIN_ID, "秒级时间戳作品", "published", started - 555)
    older = rb.WorkItem("older", same_second.title, "published", started - 1001)
    future = rb.WorkItem("future", same_second.title, "published", started + 1001)
    assert rb.find_published_work([older, future], same_second.title, since_ms=started, exclude_ids=set()) is None
    assert rb.find_published_work([same_second], same_second.title, since_ms=started, exclude_ids=set()) is same_second


def test_current_publish_does_not_choose_among_ambiguous_title_candidates(monkeypatch):
    started = 1_791_421_200_000
    monkeypatch.setattr(rb.time, "time", lambda: started / 1000)
    first = rb.WorkItem("first", "相同的标题前缀足够长不同结尾甲", "published", started)
    second = rb.WorkItem("second", "相同的标题前缀足够长不同结尾乙", "published", started)
    assert rb.find_published_work([first, second], first.title, since_ms=started) is None
    assert rb.find_published_work([second, first], first.title, since_ms=started) is None
    assert rb.find_published_work([first, second], first.title, since_ms=started, exclude_ids={"first"}) is second
    assert rb.find_published_work([first, second], first.title) is first
    assert rb.find_published_work([first, second], first.title, exclude_ids={"first"}) is second


@pytest.mark.parametrize("platform,content_id", [("douyin", DOUYIN_ID), ("kuaishou", KUAISHOU_ID), ("bilibili", BVID)])
def test_failed_snapshot_and_missing_time_cannot_verify_an_old_public_work(platform, content_id, monkeypatch):
    started = 1_791_421_200_000
    monkeypatch.setattr(rb.time, "time", lambda: started / 1000)
    def unavailable(*_args, **_kwargs):
        raise OSError("simulated snapshot unavailable")
    monkeypatch.setattr(rb, f"read_{platform}_works", unavailable)
    snapshot = getattr(rb, f"capture_{platform}_snapshot")(object())
    assert snapshot == set()
    old = rb.WorkItem(content_id, "同标题旧作品", "published", None)
    monkeypatch.setattr(rb, f"read_{platform}_works", lambda *_args, **_kwargs: [old])
    result = getattr(rb, f"verify_{platform}_publish")(
        object(), title=old.title, since_ms=started, attempts=1, delay_s=0, snapshot_ids=snapshot)
    assert result.outcome == "unverified" and result.matched is None
    assert result.candidates == [old]
    receipt = receipts.from_readback(platform, result)
    assert receipt["outcome"] == "unverified" and receipt["url"] == ""


@pytest.mark.parametrize("platform,content_id", [("douyin", DOUYIN_ID), ("kuaishou", KUAISHOU_ID), ("bilibili", BVID)])
def test_unique_timed_work_still_verifies_after_snapshot_failure(platform, content_id, monkeypatch):
    started = 1_791_421_200_000
    monkeypatch.setattr(rb.time, "time", lambda: started / 1000)
    work = rb.WorkItem(content_id, "本次唯一新作品", "published", started)
    monkeypatch.setattr(rb, f"read_{platform}_works", lambda *_args, **_kwargs: [work])
    monkeypatch.setattr(rb, f"read_{platform}_account", lambda *_args, **_kwargs: {})
    result = getattr(rb, f"verify_{platform}_publish")(
        object(), title=work.title, since_ms=started, attempts=1, delay_s=0, snapshot_ids=set())
    assert result.outcome == "verified" and result.matched is work


@pytest.mark.parametrize("url", [
    "https://zhuanlan.zhihu.com/p/123/edit", "https://zhuanlan.zhihu.com/write",
    "https://www.zhihu.com/question/123", "https://zhuanlan.zhihu.com/login?next=/p/123",
    "https://zhuanlan.zhihu.com/p/123?token=secret", "https://zhuanlan.zhihu.com/p/123#secret",
    "https://zhuanlan.zhihu.com.evil.test/p/123", "https://u:p@zhuanlan.zhihu.com/p/123",
    "https://zhuanlan.zhihu.com:443/p/123", "http://zhuanlan.zhihu.com/p/123",
    "https://zhuanlan.zhihu.com/p/123\n", "https://zhuanlan.zhihu.com/p/123/more",
    "https://zhuanlan.zhihu.com/p/123//",
])
def test_nonpublic_or_sensitive_zhihu_urls_are_not_success(url):
    row = receipts.from_ui("zhihu", url=url, signal="page_navigation")
    assert row["outcome"] == "unverified" and row["url"] == ""


def test_observed_link_must_match_the_work_id():
    url = "https://zhuanlan.zhihu.com/p/123"
    row = receipts.make_receipt("zhihu", "published", content_id="456", url=url)
    assert row["url"] == ""
    assert receipts.observed_public_work("zhihu", url, "123") == ("123", url)


def test_canonical_media_urls_and_internal_id_boundary():
    assert receipts.from_readback("douyin", verdict("published"), kind="image")["url"] == f"https://www.douyin.com/note/{DOUYIN_ID}"
    assert receipts.from_readback("kuaishou", verdict("已发布", KUAISHOU_ID))["url"] == f"https://www.kuaishou.com/short-video/{KUAISHOU_ID}"
    row = receipts.from_readback("kuaishou", verdict("已发布", "123456789012345"))
    assert row["outcome"] == "published" and row["url"] == ""
    assert receipts.from_readback("douyin", verdict("published", "../invalid"))["outcome"] == "unverified"
    assert receipts.from_readback("douyin", verdict("published", "not-an-aweme"))["outcome"] == "unverified"


@pytest.mark.parametrize("platform,url,signal,outcome", [
    ("xiaohongshu", "", "success_message", "submitted"),
    ("xiaohongshu", "", "form_reset", "submitted"),
    ("xiaohongshu", "", "page_navigation", "unverified"),
    ("weixin-channels", "https://channels.weixin.qq.com/platform/post/list", "page_navigation", "submitted"),
    ("weixin-channels", "https://channels.weixin.qq.com/login", "page_navigation", "unverified"),
    ("weixin-channels", "https://example.test/platform/post/list", "page_navigation", "unverified"),
])
def test_ui_submission_does_not_claim_publication(platform, url, signal, outcome):
    row = receipts.from_ui(platform, url=url, signal=signal)
    assert row["outcome"] == outcome and row["url"] == ""


@pytest.mark.parametrize("after_submit", [False, True])
def test_command_error_emits_one_honest_receipt(capsys, after_submit):
    @receipts.publishing_command("douyin")
    def command(_args):
        if after_submit:
            receipts.mark_submitted()
        raise RuntimeError("untrusted transport details")

    with pytest.raises(RuntimeError):
        command(SimpleNamespace(exec=True))
    row = read_receipt(capsys)
    assert row["outcome"] == ("unverified" if after_submit else "failed")


def test_dry_run_does_not_emit_a_publication_receipt(capsys):
    @receipts.publishing_command("douyin")
    def command(_args):
        return 0

    assert command(SimpleNamespace(exec=False)) == 0
    assert receipts.PREFIX not in capsys.readouterr().out


def test_receipt_is_a_full_line_even_after_partial_subprocess_output(capsys):
    sys.stdout.write("upload progress 100%")
    receipts.emit(receipts.from_readback("bilibili", verdict("开放浏览", BVID)))
    assert read_receipt(capsys)["url"] == f"https://www.bilibili.com/video/{BVID}"


class FakePage:
    def __init__(self, url):
        self.url = url

    def goto(self, *_args, **_kwargs):
        pass

    def set_default_timeout(self, *_args):
        pass

    def wait_for_timeout(self, *_args):
        pass

    def query_selector(self, *_args):
        return None


@pytest.fixture
def browser(monkeypatch):
    page = FakePage("https://creator.douyin.com/")
    context = SimpleNamespace(pages=[page], close=lambda: None)
    engine = SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=lambda *_a, **_k: context))

    class Manager:
        def __enter__(self):
            return engine

        def __exit__(self, *_args):
            return False

    class BrowserError(Exception):
        pass

    api = ModuleType("playwright.sync_api")
    api.sync_playwright = Manager
    api.TimeoutError = BrowserError
    api.Error = BrowserError
    monkeypatch.setitem(sys.modules, "playwright", ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.sync_api", api)
    for module in (dy, xhs, mp):
        monkeypatch.setattr(module, "_launch", lambda *_a, **_k: context)
    return page


@pytest.fixture
def calendar(monkeypatch):
    rows = []
    monkeypatch.setattr(calendar_ops, "record_publish", lambda *a, **kw: rows.append((a, kw)))
    return rows


def publish_args(tmp_path, **overrides):
    media = tmp_path / "media.mp4"
    media.write_bytes(b"fake media; browser is mocked")
    values = dict(title="回执测试", content="正常正文", desc="正常正文", video=str(media),
                  images=str(media), media=str(media), tags="", cover=None, exec=True,
                  headed=False, profile_base=str(tmp_path), proxy=None, no_proxy=True,
                  keep_open=False, status_file=None, sms_code_file=None, allow_unsafe=False)
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.mark.parametrize("status,outcome", [("published", "published"), ("reviewing", "submitted"),
                                            ("private", "unverified"), ("unknown", "unverified")])
def test_douyin_script_receipt_and_calendar(browser, calendar, monkeypatch, tmp_path, capsys, status, outcome):
    for name in ("_wait_ready", "_go_upload", "_switch_tab", "_upload_files", "_wait_video_processed",
                 "_select_ai_cover", "_fill_title_desc", "_click_publish", "_wait_toast"):
        monkeypatch.setattr(dy, name, lambda *_a, **_k: None)
    monkeypatch.setattr(dy, "_logged_in", lambda *_a: True)
    monkeypatch.setattr(dy, "_verify_wall", lambda *_a: False)
    monkeypatch.setattr(rb, "capture_douyin_snapshot", lambda *_a: set())
    monkeypatch.setattr(rb, "verify_douyin_publish", lambda *_a, **_k: verdict(status))
    states = []
    monkeypatch.setattr(dy.login_state, "write_status", lambda _p, state, *_a: states.append(state))
    code = dy.cmd_publish_video(publish_args(tmp_path))
    row = read_receipt(capsys)
    assert row["platform"] == "douyin" and row["outcome"] == outcome
    assert (code == 0) is (outcome in {"published", "submitted"})
    assert len(calendar) == int(outcome == "published")
    assert "success" not in states
    if calendar:
        assert calendar[0][1]["url"] == f"https://www.douyin.com/video/{DOUYIN_ID}"


@pytest.mark.parametrize("signal,outcome", [("success_message", "submitted"), ("page_navigation", "unverified")])
def test_xhs_script_never_records_ui_only_submission_as_published(browser, calendar, monkeypatch, tmp_path, capsys, signal, outcome):
    browser.url = xhs.PUBLISH_URL
    monkeypatch.setattr(xhs, "_query_safe", lambda *_a: object())
    monkeypatch.setattr(xhs, "_click_publish_tab", lambda *_a: None)
    monkeypatch.setattr(xhs, "_upload_images", lambda *_a: None)
    def submit(*_args, **kwargs):
        kwargs['before_submit']()
        return signal
    monkeypatch.setattr(xhs, "_fill_and_submit", submit)
    monkeypatch.setattr(xhs.xhs_readback, "capture_xhs_snapshot", lambda *_a: None)
    monkeypatch.setattr(xhs.xhs_readback, "verify_xhs_publish", lambda *_a, **_k: rb.ReadbackResult('unverified'))
    code = xhs.cmd_publish(publish_args(tmp_path))
    row = read_receipt(capsys)
    assert row["outcome"] == outcome and row["url"] == "" and calendar == []
    assert (code == 0) is (outcome == "submitted")


def test_xhs_login_redirect_is_not_a_success_signal():
    with pytest.raises(SystemExit) as exc:
        xhs._wait_publish_success(FakePage("https://creator.xiaohongshu.com/login"))
    assert exc.value.code == 5


def test_douyin_ui_feedback_does_not_announce_published(capsys):
    dy._wait_toast(FakePage("https://creator.douyin.com/creator-micro/content/manage"))
    assert "发布成功" not in capsys.readouterr().out


@pytest.mark.parametrize("response,outcome", [({"ret": 0, "appMsgId": "12345"}, "draft"),
                                             ({"ret": 0}, "unverified"), ({"ret": -1}, "failed"),
                                             ({"ret": 0, "appMsgId": {"token": "private"}}, "unverified")])
def test_wechat_script_emits_draft_and_no_public_link(browser, calendar, monkeypatch, tmp_path, capsys, response, outcome):
    browser.url = "https://mp.weixin.qq.com/cgi-bin/home?token=123456&lang=zh_CN"
    monkeypatch.setattr(mp, "_editor_ctx", lambda *_a: {"ticket": "private-ticket", "user_name": "test-user"})
    upload = {"base_resp": {"ret": 0}, "content": "thumb-id", "cdn_url": "https://mmbiz.qpic.cn/fake"}
    browser.request = SimpleNamespace(post=lambda url, **_kw: SimpleNamespace(json=lambda: upload if "filetransfer" in url else response))
    html = tmp_path / "article.html"
    html.write_text("<p>正文</p>", encoding="utf-8")
    args = publish_args(tmp_path, html=str(html), digest="", author="", source_url="")
    args.cover = args.media
    code = mp.cmd_publish(args)
    row = read_receipt(capsys)
    assert row["platform"] == "wechat-oa" and row["outcome"] == outcome
    assert row["url"] == "" and calendar == []
    assert (code == 0) is (outcome == "draft")
    assert "private-ticket" not in json.dumps(row) and "123456" not in json.dumps(row)


@pytest.mark.parametrize("status,outcome", [("已发布", "published"), ("审核中", "submitted"), ("private", "unverified")])
def test_kuaishou_script_uses_platform_state_for_calendar(browser, calendar, monkeypatch, tmp_path, capsys, status, outcome):
    browser.url = "https://cp.kuaishou.com/article/manage/video"
    monkeypatch.setattr(wp, "_profile_dir", lambda *_a: tmp_path)
    monkeypatch.setattr(wp, "_settle_login", lambda *_a: None)
    monkeypatch.setattr(wp, "_is_logged_in", lambda *_a: True)
    monkeypatch.setattr(wp, "_probe_publish_auth", lambda *_a: "active")
    monkeypatch.setattr(wp, "_resolve_steps", lambda *_a: [])
    monkeypatch.setattr(wp, "_readback_capture", lambda *_a: set())
    monkeypatch.setattr(wp, "_readback_verify", lambda *_a, **_k: verdict(status, KUAISHOU_ID))
    code = wp.cmd_publish(publish_args(tmp_path, platform="kuaishou"))
    row = read_receipt(capsys)
    assert row["outcome"] == outcome and len(calendar) == int(outcome == "published")
    assert (code == 0) is (outcome in {"published", "submitted"})
    if calendar:
        assert calendar[0][1]["url"] == f"https://www.kuaishou.com/short-video/{KUAISHOU_ID}"


def test_zhihu_script_returns_observed_exact_article_link(browser, calendar, monkeypatch, tmp_path, capsys):
    browser.url = "https://zhuanlan.zhihu.com/p/123456789"
    monkeypatch.setattr(wp, "_profile_dir", lambda *_a: tmp_path)
    monkeypatch.setattr(wp, "_settle_login", lambda *_a: None)
    monkeypatch.setattr(wp, "_is_logged_in", lambda *_a: True)
    monkeypatch.setattr(wp, "_resolve_steps", lambda *_a: [])
    assert wp.cmd_publish(publish_args(tmp_path, platform="zhihu", media=None)) == 0
    row = read_receipt(capsys)
    assert row["outcome"] == "published" and row["url"] == browser.url
    assert row["contentId"] == "123456789" and calendar[0][1]["url"] == browser.url


def test_zero_exit_without_receipt_does_not_record_published(calendar, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(wp, "_run_browser", lambda *_a, **_k: 0)
    assert wp.cmd_publish(publish_args(tmp_path, platform="zhihu", media=None)) == 0
    assert read_receipt(capsys)["outcome"] == "unverified" and calendar == []


@pytest.fixture
def bili_args(monkeypatch, tmp_path):
    cookie = tmp_path / "cookies.json"
    cookie.write_text("{}", encoding="utf-8")
    args = publish_args(tmp_path, cookie=str(cookie), partition=None, tid=36, tag="",
                        copyright=1, source="", dtime=None)
    monkeypatch.setattr(bili, "_has_biliup", lambda: True)
    monkeypatch.setattr(rb, "capture_bilibili_snapshot", lambda _cookie: {"previous-id"})
    monkeypatch.setattr(bili.subprocess, "call", lambda _cmd, **_kw: 0)
    return args


@pytest.mark.parametrize("state,description,content_id,outcome", [
    (0, "", BVID, "published"), (0, "开放浏览", BVID, "published"),
    (-1, "", BVID, "submitted"), (-2, "审核中", BVID, "submitted"),
    (-16, "", BVID, "unverified"), (-4, "", BVID, "failed"),
    (-999, "", BVID, "unverified"), (0, "", "", "unverified"),
])
def test_bilibili_wrapper_separates_public_archives_from_review_private_and_av_only(
        bili_args, calendar, monkeypatch, capsys, state, description, content_id, outcome):
    work = rb._map_bilibili_item({"Archive": {"bvid": content_id, "aid": 1234567,
                                            "title": bili_args.title, "state": state,
                                            "state_desc": description, "ctime": 1}})
    captured = []

    def verify(cookie, **kwargs):
        captured.append((cookie, kwargs))
        return rb.ReadbackResult("verified", matched=work)

    monkeypatch.setattr(rb, "verify_bilibili_publish", verify)
    code = bili.cmd_upload(bili_args)
    row = read_receipt(capsys)
    assert row["platform"] == "bilibili" and row["outcome"] == outcome
    assert (code == 0) is (outcome in {"published", "submitted"})
    assert captured[0][0] == bili_args.cookie
    assert captured[0][1]["snapshot_ids"] == {"previous-id"}
    assert captured[0][1]["title"] == bili_args.title and captured[0][1]["since_ms"] > 0
    assert len(calendar) == int(outcome == "published")
    if calendar:
        assert row["url"] == calendar[0][1]["url"] == f"https://www.bilibili.com/video/{BVID}"
    else:
        assert row["url"] == ""


def test_bilibili_cli_error_is_unverified_and_not_recorded(bili_args, calendar, monkeypatch, capsys):
    monkeypatch.setattr(bili.subprocess, "call", lambda _cmd, **_kw: 7)
    monkeypatch.setattr(rb, "verify_bilibili_publish", lambda *_a, **_kw: pytest.fail("must not read back this error path"))
    assert bili.cmd_upload(bili_args) == 7
    assert read_receipt(capsys)["outcome"] == "unverified" and calendar == []


def test_bilibili_readback_exception_never_announces_publication(bili_args, calendar, monkeypatch, capsys):
    def fail(*_args, **_kwargs):
        raise RuntimeError("sensitive transport details")

    monkeypatch.setattr(rb, "verify_bilibili_publish", fail)
    assert bili.cmd_upload(bili_args) == 4
    row = read_receipt(capsys)
    assert row["outcome"] == "unverified" and row["url"] == "" and calendar == []
    assert "sensitive" not in json.dumps(row)


def test_bilibili_dry_run_does_not_upload_or_read_back(bili_args, calendar, monkeypatch, capsys):
    bili_args.exec = False
    monkeypatch.setattr(bili.subprocess, "call", lambda *_a, **_kw: pytest.fail("must not upload a dry-run"))
    monkeypatch.setattr(rb, "capture_bilibili_snapshot", lambda *_a: pytest.fail("must not access the platform in dry-run"))
    assert bili.cmd_upload(bili_args) == 0
    assert receipts.PREFIX not in capsys.readouterr().out and calendar == []
