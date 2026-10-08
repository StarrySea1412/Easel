"""Synthetic first-party-shaped payloads; no platform session or publishing."""
from __future__ import annotations

import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills/shared/scripts"))

import channels_readback as channels
import platform_readback as readback
import publish_receipt
import web_publisher as publisher

NOW_MS = 1_790_000_000_500
CONTENT_ID = "17900000000000000001"
TITLE = "视频号回执定向测试"


@pytest.fixture(autouse=True)
def fixed_time(monkeypatch):
    monkeypatch.setattr(channels.time, "time", lambda: NOW_MS / 1000)


def raw_work(**overrides):
    value = {"objectId": CONTENT_ID, "desc": {"description": TITLE + "\n正常正文\n#测试"},
             "createTime": NOW_MS // 1000, "handleStatus": 2, "effectiveTime": 0,
             "visibleType": 1, "flag": 0, "isPreview": False}
    value.update(overrides)
    return value


def envelope(*items):
    return {"errCode": 0, "data": {"baseResp": {"errcode": 0}, "list": list(items)}}


@pytest.mark.parametrize("patch,status", [
    ({}, "published"), ({"handleStatus": 1}, "processing"),
    ({"handleStatus": 3}, "failed"), ({"handleStatus": 4}, "failed"),
    ({"handleStatus": 5}, "failed"), ({"handleStatus": 0}, "unknown"),
    ({"handleStatus": True}, "unknown"), ({"handleStatus": "2"}, "unknown"),
    ({"effectiveTime": NOW_MS // 1000 - 60}, "scheduled"),
    ({"effectiveTime": NOW_MS // 1000 + 60}, "scheduled"),
    ({"effectiveTime": -1}, "unknown"), ({"effectiveTime": False}, "unknown"),
    ({"effectiveTime": "0"}, "unknown"), ({"visibleType": 2}, "private"),
    ({"visibleType": 3}, "private"), ({"visibleType": 4}, "unknown"),
    ({"visibleType": True}, "unknown"), ({"visibleType": "1"}, "unknown"),
    ({"flag": 256}, "private"), ({"flag": 1024}, "private"),
    ({"flag": 32768}, "private"), ({"flag": 65536}, "unknown"),
    ({"flag": -1}, "unknown"), ({"flag": False}, "unknown"),
    ({"flag": "0"}, "unknown"), ({"isPreview": True}, "private"),
    ({"isPreview": 1}, "private"), ({"isPreview": "false"}, "unknown"),
    ({"status": 1}, "unknown"), ({"auditStatus": 0}, "unknown"),
    ({"objectStatus": 1}, "unknown"),
    ({"originalInfo": {"isDeclared": True, "auditOriginalFlag": 0}}, "published"),
])
def test_states_need_processing_visibility_timing_and_no_restriction(patch, status):
    assert channels.normalize_status(raw_work(**patch)) == status


@pytest.mark.parametrize("key", ["handleStatus", "effectiveTime", "visibleType", "flag"])
def test_missing_positive_state_evidence_is_unknown(key):
    raw = raw_work()
    del raw[key]
    assert channels.normalize_status(raw) == "unknown"


def test_map_uses_full_first_title_line_and_exact_large_id():
    mapped = channels.map_work(raw_work(objectId=int(CONTENT_ID)))
    assert mapped.platform_content_id == CONTENT_ID
    assert mapped.title == TITLE
    assert mapped.published_at_ms == NOW_MS // 1000 * 1000


@pytest.mark.parametrize("bad_id", [True, 1.79e19, "../x", "export/unsupported", "", "0", "a" * 129, None])
def test_unsupported_identity_is_not_coerced_or_guessed(bad_id):
    assert channels.map_work(raw_work(objectId=bad_id)) is None


@pytest.mark.parametrize("timestamp", [True, "1790000000", "2026-09-21", 1790000000.5, None, -1])
def test_invalid_timestamp_cannot_match(timestamp):
    work = channels.map_work(raw_work(createTime=timestamp))
    assert work.published_at_ms is None
    assert channels.find_channels_work([work], title=TITLE, since_ms=NOW_MS) is None


@pytest.mark.parametrize("body", [
    None, [], {}, {"errCode": True, "data": {"list": []}},
    {"errCode": "0", "data": {"list": []}},
    {"errCode": 300500, "data": {"list": [raw_work()]}},
    {"errCode": 0, "data": {"other": {"list": [raw_work()]}}},
    {"errCode": 0, "data": {"list": "not-list"}},
    {"errCode": 0, "data": {"baseResp": {"errcode": 1}, "list": [raw_work()]}},
    {"errCode": 0, "data": {"baseResp": {"errcode": False}, "list": [raw_work()]}},
    {"errCode": 0, "data": {"baseResp": {}, "list": [raw_work()]}},
    envelope({"id": CONTENT_ID, "title": TITLE}),
])
def test_only_known_successful_own_list_envelope_is_parsed(body):
    with pytest.raises(RuntimeError):
        channels.parse_list_response(body)


def test_parser_preserves_conflicting_duplicates():
    works = channels.parse_list_response(envelope(raw_work(), raw_work(visibleType=3)))
    assert len(works) == 2
    assert channels.find_channels_work(works, title=TITLE, since_ms=NOW_MS) is None


def test_malformed_or_excess_rows_cannot_hide_a_duplicate():
    with pytest.raises(RuntimeError):
        channels.parse_list_response(envelope(raw_work(), raw_work(objectId="unsupported/id")))
    with pytest.raises(RuntimeError):
        channels.parse_list_response(envelope(*[raw_work() for _ in range(101)]))


@pytest.mark.parametrize("code", [300330, 300334, 300349])
def test_first_party_session_expiry_codes(code):
    with pytest.raises(readback.LoginRequiredError):
        channels.parse_list_response({"errCode": code})
    with pytest.raises(readback.LoginRequiredError):
        channels.parse_list_response({"errCode": 0, "data": {"baseResp": {"errcode": code}, "list": []}})


def response(body=None, *, url=None, method="POST", status=200):
    return SimpleNamespace(url=url or "https://channels.weixin.qq.com" + channels.LIST_PATH,
                           request=SimpleNamespace(method=method), status=status,
                           json=lambda: body if body is not None else envelope(raw_work()))


@pytest.mark.parametrize("url,method", [
    ("https://channels.weixin.qq.com.evil.example" + channels.LIST_PATH, "POST"),
    ("http://channels.weixin.qq.com" + channels.LIST_PATH, "POST"),
    ("https://user:secret@channels.weixin.qq.com" + channels.LIST_PATH, "POST"),
    ("https://channels.weixin.qq.com:443" + channels.LIST_PATH, "POST"),
    ("https://channels.weixin.qq.com" + channels.LIST_PATH + "/other", "POST"),
    ("https://channels.weixin.qq.com" + channels.LIST_PATH + "#post", "POST"),
    ("https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/post/post_create", "POST"),
    ("https://channels.weixin.qq.com" + channels.LIST_PATH, "GET"),
])
def test_unrelated_or_unsafe_responses_are_ignored(url, method):
    assert not channels._is_list_response(response(url=url, method=method))


class ListPage:
    def __init__(self, replies=(), *, landed=None, qr=False):
        self.replies = list(replies)
        self.landed = landed
        self.url = channels.MANAGE_URL
        self.qr = qr
        self.listeners = {}
        self.actions = []

    def on(self, event, handler):
        self.listeners[event] = handler

    def remove_listener(self, event, handler):
        assert self.listeners.pop(event) is handler

    def goto(self, url, **kwargs):
        self.actions.append(("goto", url))
        self.url = self.landed or url
        for reply in self.replies:
            self.listeners["response"](reply)

    def query_selector(self, _selector):
        return SimpleNamespace(is_visible=lambda: True) if self.qr else None

    def wait_for_timeout(self, ms):
        self.actions.append(("wait", ms))


def test_read_observes_platform_response_without_replaying_request():
    page = ListPage([response(url="https://channels.weixin.qq.com" + channels.LIST_PATH + "?signed=secret")])
    works = channels.read_channels_works(page)
    assert works[0].platform_content_id == CONTENT_ID
    assert page.actions == [("goto", channels.MANAGE_URL)]
    assert page.listeners == {}


@pytest.mark.parametrize("page", [
    ListPage([response()], landed="https://channels.weixin.qq.com/login.html"),
    ListPage([response()], qr=True),
    ListPage([response(status=401)]),
    ListPage([response(body={"errCode": 300334})]),
])
def test_expired_session_is_explicit_and_listener_is_removed(page):
    with pytest.raises(readback.LoginRequiredError):
        channels.read_channels_works(page)
    assert page.listeners == {}


def test_wrong_page_and_transport_errors_do_not_expose_raw_payload():
    page = ListPage([response()], landed="https://example.test/?token=secret")
    with pytest.raises(RuntimeError) as error:
        channels.read_channels_works(page)
    assert "secret" not in str(error.value)
    reply = response()
    reply.json = lambda: (_ for _ in ()).throw(RuntimeError("token=secret"))
    page = ListPage([reply])
    with pytest.raises(RuntimeError) as error:
        channels.read_channels_works(page)
    assert "secret" not in str(error.value)
    assert page.listeners == {}


def test_capture_distinguishes_empty_from_failed_list():
    assert channels.capture_channels_snapshot(ListPage([response(envelope())])) == set()
    assert channels.capture_channels_snapshot(ListPage([response(status=403)])) is None


def test_match_requires_full_title_recent_time_and_unique_identity():
    current = channels.map_work(raw_work())
    old = channels.map_work(raw_work(objectId="old-work", createTime=NOW_MS // 1000 - 60))
    other = channels.map_work(raw_work(objectId="other-work", desc={"description": TITLE + "的另一篇作品"}))
    assert channels.find_channels_work([old, other, current], title=TITLE, since_ms=NOW_MS) is current
    assert channels.find_channels_work([current], title=TITLE, since_ms=NOW_MS, snapshot_ids={CONTENT_ID}) is None
    assert channels.find_channels_work([current], title=TITLE, since_ms=NOW_MS, content_id="another-id") is None
    same_title = channels.map_work(raw_work(objectId="another-id"))
    assert channels.find_channels_work([current, same_title], title=TITLE, since_ms=NOW_MS) is None
    assert channels.find_channels_work([current, same_title], title=TITLE, since_ms=NOW_MS,
                                      content_id=CONTENT_ID) is current


@pytest.mark.parametrize("since_ms", [NOW_MS // 1000, NOW_MS + 120000, -1, True, float(NOW_MS), None])
def test_invalid_or_future_since_cannot_identify_submission(since_ms):
    work = channels.map_work(raw_work())
    assert channels.find_channels_work([work], title=TITLE, since_ms=since_ms) is None


def test_submission_finish_excludes_later_same_title_repost():
    work = channels.map_work(raw_work())
    since_ms, until_ms = NOW_MS - 60_000, NOW_MS - 30_000
    assert channels.find_channels_work([work], title=TITLE, since_ms=since_ms) is work
    assert channels.find_channels_work([work], title=TITLE, since_ms=since_ms,
                                      until_ms=until_ms) is None
    original = channels.map_work(raw_work(objectId="original-work", createTime=until_ms))
    assert channels.find_channels_work([work, original], title=TITLE, since_ms=since_ms,
                                      until_ms=until_ms) is original


@pytest.mark.parametrize("delta,matched", [(-1, True), (0, True), (999, True), (1000, True), (1001, False)])
def test_submission_finish_has_at_most_one_second_precision_tolerance(delta, matched):
    since_ms, until_ms = NOW_MS - 60_000, NOW_MS - 30_000
    work = channels.map_work(raw_work(createTime=until_ms + delta))
    found = channels.find_channels_work([work], title=TITLE, since_ms=since_ms, until_ms=until_ms)
    assert (found is work) is matched


def test_future_finish_never_accepts_future_work():
    work = channels.map_work(raw_work(createTime=NOW_MS + 1001))
    assert channels.find_channels_work([work], title=TITLE, since_ms=NOW_MS,
                                      until_ms=NOW_MS + 60_000) is None


@pytest.mark.parametrize("content_id", ["", CONTENT_ID])
@pytest.mark.parametrize("until_ms", [NOW_MS - 1, NOW_MS // 1000, -1, True, float(NOW_MS), "invalid"])
def test_invalid_finish_or_reversed_window_is_rejected_before_read(until_ms, content_id):
    work = channels.map_work(raw_work())
    assert channels.find_channels_work([work], title=TITLE, since_ms=NOW_MS,
                                      until_ms=until_ms, content_id=content_id) is None
    page = ListPage([response()])
    result = channels.verify_channels_publish(page, title=TITLE, since_ms=NOW_MS,
                                              until_ms=until_ms, content_id=content_id)
    assert result.outcome == "unverified" and result.error == "核实参数无效"
    assert page.actions == [] and result.evidence["attempts"] == 0


@pytest.mark.parametrize("timestamp", [None, NOW_MS - 120_000, NOW_MS + 120_000])
@pytest.mark.parametrize("edited_title", ["已编辑的作品标题", ""])
def test_known_id_survives_title_and_date_edits(timestamp, edited_title):
    since_ms, until_ms = NOW_MS - 60_000, NOW_MS - 30_000
    original = raw_work(desc={"description": edited_title}, createTime=timestamp)
    other = raw_work(objectId="later-repost")
    page = ListPage([response(envelope(original, other))])
    result = channels.verify_channels_publish(page, title="", since_ms=since_ms,
                                              until_ms=until_ms, content_id=CONTENT_ID, attempts=1)
    assert result.outcome == "verified" and result.matched.platform_content_id == CONTENT_ID
    assert result.evidence["matchedBy"] == "content_id"
    assert result.evidence["untilMs"] == until_ms
    receipt = channels.receipt_from_result(result, read_only=True)
    assert receipt["evidence"]["untilMs"] == until_ms and receipt["outcome"] == "published"


def test_known_id_does_not_fall_back_and_still_requires_unique_unsnapshotted_work():
    current = channels.map_work(raw_work(desc={"description": "已编辑的作品标题"}, createTime=None))
    other = channels.map_work(raw_work(objectId="later-repost"))
    assert channels.find_channels_work([other], title=TITLE, since_ms=NOW_MS, content_id=CONTENT_ID) is None
    assert channels.find_channels_work([current, current, other], title=TITLE, since_ms=NOW_MS,
                                      content_id=CONTENT_ID) is None
    assert channels.find_channels_work([current], title=TITLE, since_ms=NOW_MS,
                                      content_id=CONTENT_ID, snapshot_ids={CONTENT_ID}) is None


def test_bounded_recheck_does_not_mislabel_missing_or_error(monkeypatch):
    page = ListPage([response(envelope())])
    result = channels.verify_channels_publish(page, title=TITLE, since_ms=NOW_MS, attempts=2)
    assert result.outcome == "unverified" and result.evidence["attempts"] == 2
    assert [action for action in page.actions if action[0] == "goto"] == [
        ("goto", channels.MANAGE_URL), ("goto", channels.MANAGE_URL)]
    result = channels.verify_channels_publish(ListPage([response(status=500)]), title=TITLE,
                                              since_ms=NOW_MS, attempts=1)
    assert result.outcome == "readback_error"
    result = channels.verify_channels_publish(ListPage([response(status=401)]), title=TITLE,
                                              since_ms=NOW_MS, attempts=3)
    assert result.outcome == "login_required" and result.evidence["attempts"] == 1


def test_closed_page_during_retry_returns_uncertainty():
    page = ListPage([response(status=500)])
    page.wait_for_timeout = lambda _ms: (_ for _ in ()).throw(RuntimeError("browser closed; private=secret"))
    result = channels.verify_channels_publish(page, title=TITLE, since_ms=NOW_MS, attempts=3)
    assert result.outcome == "readback_error" and "secret" not in json.dumps(result.as_dict())


@pytest.mark.parametrize("patch,outcome", [({}, "published"), ({"handleStatus": 1}, "submitted"),
    ({"effectiveTime": NOW_MS // 1000 + 60}, "submitted"), ({"handleStatus": 3}, "failed"),
    ({"visibleType": 3}, "unverified"), ({"flag": 65536}, "unverified")])
def test_verified_identity_alone_is_not_publication_and_no_url_is_guessed(patch, outcome):
    result = channels.verify_channels_publish(ListPage([response(envelope(raw_work(**patch)))]),
                                              title=TITLE, since_ms=NOW_MS, attempts=1)
    assert result.outcome == "verified"
    receipt = channels.receipt_from_result(result, read_only=True)
    assert receipt["outcome"] == outcome
    assert receipt["contentId"] == CONTENT_ID
    assert receipt["url"] == ""
    assert receipt["evidence"]["readOnly"] is True
    assert receipt["evidence"]["publicAccessChecked"] is False


def test_receipt_drops_raw_errors_and_candidate_data(monkeypatch):
    monkeypatch.setenv("EASEL_PUBLISH_RECEIPT_ID", "original-submission-id")
    result = readback.ReadbackResult("readback_error", candidates=[channels.map_work(raw_work())],
                                     error="cookie=secret", evidence={"token": "secret"})
    receipt = channels.receipt_from_result(result, read_only=True)
    assert receipt["receiptId"] == "original-submission-id"
    assert "secret" not in json.dumps(receipt) and TITLE not in json.dumps(receipt, ensure_ascii=False)


def install_browser(monkeypatch, page):
    launches, closes = [], []
    context = SimpleNamespace(pages=[page], close=lambda: closes.append(True))

    def launch(*args, **kwargs):
        launches.append((args, kwargs))
        return context

    class Manager:
        def __enter__(self):
            return SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=launch))

        def __exit__(self, *_args):
            return False

    api = ModuleType("playwright.sync_api")
    api.sync_playwright = Manager
    api.TimeoutError = type("BrowserTimeout", (Exception,), {})
    monkeypatch.setitem(sys.modules, "playwright", ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.sync_api", api)
    return launches, closes


def cli_args(tmp_path, **overrides):
    values = dict(platform="weixin-channels", title=TITLE, since_ms=NOW_MS, content_id=CONTENT_ID,
                  until_ms=None, profile_base=str(tmp_path), headed=False, proxy=None, no_proxy=False)
    values.update(overrides)
    return SimpleNamespace(**values)


def get_receipt(capsys):
    rows = [line.removeprefix(publish_receipt.PREFIX) for line in capsys.readouterr().out.splitlines()
            if line.startswith(publish_receipt.PREFIX)]
    assert len(rows) == 1
    return json.loads(rows[0])


def test_verify_cli_uses_existing_profile_and_never_calls_publish(monkeypatch, tmp_path, capsys):
    (tmp_path / "ChannelsProfile").mkdir()
    page = ListPage([response(envelope(raw_work()))])
    launches, closes = install_browser(monkeypatch, page)
    monkeypatch.setenv("EASEL_PUBLISH_RECEIPT_ID", "receipt-original")
    for name in ("_run_browser", "_publish_weixin_channels", "cmd_publish", "cmd_login"):
        monkeypatch.setattr(publisher, name, lambda *_a, **_k: pytest.fail("verify called a publishing/login action"))
    assert publisher.cmd_verify_publish(cli_args(tmp_path)) == 0
    receipt = get_receipt(capsys)
    assert receipt["outcome"] == "published" and receipt["receiptId"] == "receipt-original"
    assert receipt["evidence"]["readOnly"] is True and receipt["url"] == ""
    assert launches[0][0] == (str(tmp_path / "ChannelsProfile"),)
    assert "--no-proxy-server" in launches[0][1]["args"]
    assert closes == [True]
    assert page.actions == [("goto", channels.MANAGE_URL)]


def test_verify_cli_passes_explicit_proxy_headed_and_keeps_errors_uncertain(monkeypatch, tmp_path, capsys):
    (tmp_path / "ChannelsProfile").mkdir()
    page = ListPage([])
    launches, closes = install_browser(monkeypatch, page)
    monkeypatch.setattr(channels, "verify_channels_publish", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("token=secret")))
    code = publisher.cmd_verify_publish(cli_args(tmp_path, proxy="http://127.0.0.1:8888", headed=True))
    receipt = get_receipt(capsys)
    assert code == 5 and receipt["outcome"] == "unverified"
    assert "secret" not in json.dumps(receipt)
    assert launches[0][1]["proxy"] == {"server": "http://127.0.0.1:8888"}
    assert launches[0][1]["headless"] is False
    assert "--no-proxy-server" not in launches[0][1]["args"] and closes == [True]


def test_verify_missing_profile_never_creates_login_state(monkeypatch, tmp_path, capsys):
    launches, closes = install_browser(monkeypatch, ListPage())
    assert publisher.cmd_verify_publish(cli_args(tmp_path)) == 5
    assert get_receipt(capsys)["platformStatus"] == "login_required"
    assert launches == [] and closes == [] and not (tmp_path / "ChannelsProfile").exists()


def test_verify_interruption_closes_browser_and_preserves_uncertainty(monkeypatch, tmp_path, capsys):
    (tmp_path / "ChannelsProfile").mkdir()
    _, closes = install_browser(monkeypatch, ListPage())
    monkeypatch.setattr(channels, "verify_channels_publish", lambda *_a, **_k: (_ for _ in ()).throw(KeyboardInterrupt()))
    assert publisher.cmd_verify_publish(cli_args(tmp_path)) == 5
    assert get_receipt(capsys)["outcome"] == "unverified" and closes == [True]


def test_verify_cli_requires_millisecond_timestamp_and_has_no_exec(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(publisher, "cmd_verify_publish", lambda args: calls.append(args) or 0)
    args = ["web_publisher.py", "verify-publish", "--platform", "weixin-channels", "--title", TITLE,
            "--since-ms", str(NOW_MS), "--profile-base", str(tmp_path)]
    monkeypatch.setattr(sys, "argv", args)
    assert publisher.main() == 0
    assert calls[0].since_ms == NOW_MS and calls[0].content_id == "" and not hasattr(calls[0], "exec")
    assert calls[0].until_ms is None
    monkeypatch.setattr(sys, "argv", args + ["--until-ms", str(NOW_MS)])
    assert publisher.main() == 0 and calls[-1].until_ms == NOW_MS
    for invalid_args in (args + ["--exec"], args[:7], args[:7] + [str(NOW_MS // 1000)] + args[8:],
                         args + ["--proxy", "http://127.0.0.1:8888", "--no-proxy"]):
        monkeypatch.setattr(sys, "argv", invalid_args)
        with pytest.raises(SystemExit) as error:
            publisher.main()
        assert error.value.code == 2


@pytest.mark.parametrize("until_ms", [str(NOW_MS - 1), str(NOW_MS // 1000), "-1", "true", str(float(NOW_MS))])
def test_verify_cli_rejects_invalid_finish_before_dispatch(monkeypatch, until_ms):
    monkeypatch.setattr(publisher, "cmd_verify_publish", lambda _args: pytest.fail("invalid window was dispatched"))
    monkeypatch.setattr(sys, "argv", ["web_publisher.py", "verify-publish", "--platform", "weixin-channels",
                                     "--title", TITLE, "--since-ms", str(NOW_MS), "--until-ms", until_ms])
    with pytest.raises(SystemExit) as error:
        publisher.main()
    assert error.value.code == 2


def test_verify_cli_passes_finish_and_rejects_later_repost(monkeypatch, tmp_path, capsys):
    (tmp_path / "ChannelsProfile").mkdir()
    page = ListPage([response(envelope(raw_work()))])
    _, closes = install_browser(monkeypatch, page)
    since_ms, until_ms = NOW_MS - 60_000, NOW_MS - 30_000
    assert publisher.cmd_verify_publish(cli_args(tmp_path, content_id="", since_ms=since_ms,
                                                  until_ms=until_ms)) == 5
    receipt = get_receipt(capsys)
    assert receipt["outcome"] == "unverified" and receipt["contentId"] == ""
    assert receipt["evidence"]["untilMs"] == until_ms and closes == [True]


def test_verify_cli_direct_call_validates_time_window_before_browser(monkeypatch, tmp_path, capsys):
    launches, closes = install_browser(monkeypatch, ListPage())
    assert publisher.cmd_verify_publish(cli_args(tmp_path, until_ms=NOW_MS - 1)) == 5
    assert get_receipt(capsys)["outcome"] == "unverified"
    assert launches == [] and closes == []


def test_verify_cli_known_id_accepts_empty_title(monkeypatch, tmp_path, capsys):
    (tmp_path / "ChannelsProfile").mkdir()
    page = ListPage([response(envelope(raw_work(desc={"description": "已修改标题"}, createTime=None)))])
    _, closes = install_browser(monkeypatch, page)
    assert publisher.cmd_verify_publish(cli_args(tmp_path, title="", until_ms=NOW_MS)) == 0
    receipt = get_receipt(capsys)
    assert receipt["outcome"] == "published" and receipt["contentId"] == CONTENT_ID
    assert receipt["evidence"]["matchedBy"] == "content_id" and closes == [True]


class SubmissionPage:
    """All form actions are local fakes; no browser or real media is used."""
    def __init__(self, *, press_raises=False, focus_states=()):
        self.url = channels.MANAGE_URL
        self.actions = []
        self.press_raises = press_raises
        self.focus_states = list(focus_states)
        self.frames = [SimpleNamespace(url="https://channels.weixin.qq.com/micro/content/post/create",
                                       evaluate=self.evaluate)]
        self.keyboard = SimpleNamespace(press=self.press)

    def evaluate(self, script, *_args):
        if "() => !!document.querySelector" in script:
            return True
        if "return document.activeElement" in script:
            return self.focus_states.pop(0) if self.focus_states else "focused"

    def press(self, key):
        self.actions.append(("press", key))
        if self.press_raises:
            raise RuntimeError("Navigation destroyed context after submission")

    def goto(self, url, **_kwargs):
        self.url = url

    def wait_for_timeout(self, _ms):
        pass

    def wait_for_selector(self, *_args, **_kwargs):
        pass

    def wait_for_url(self, *_args, **_kwargs):
        self.url = "https://channels.weixin.qq.com/platform/post/create"

    def set_input_files(self, *_args, **_kwargs):
        self.actions.append(("upload", "fake"))

    def locator(self, _selector):
        return SimpleNamespace(count=lambda: 1, nth=lambda _i: SimpleNamespace(is_visible=lambda: True, click=lambda: None))


@pytest.mark.parametrize("press_raises,focus_states", [(False, []), (True, []), (False, ["not-focused", "focused"])])
def test_slow_navigation_or_press_error_never_resubmits(monkeypatch, press_raises, focus_states):
    monkeypatch.setattr(publisher, "_settle_login", lambda *_a: None)
    monkeypatch.setattr(publisher, "_is_logged_in", lambda *_a: True)
    submitted = []
    monkeypatch.setattr(publish_receipt, "mark_submitted", lambda: submitted.append(True))
    page = SubmissionPage(press_raises=press_raises, focus_states=focus_states)
    timestamp = publisher._publish_weixin_channels(page, {"media": "mock.mp4", "title": TITLE})
    assert timestamp == NOW_MS
    assert page.actions == [("upload", "fake"), ("press", "Enter")]
    assert submitted == [True]


@pytest.mark.parametrize("handle_status,outcome", [(2, "published"), (1, "submitted"), (3, "failed")])
def test_publish_flow_reads_back_channels_before_calendar(monkeypatch, tmp_path, capsys, handle_status, outcome):
    page = ListPage()
    install_browser(monkeypatch, page)
    monkeypatch.setattr(publisher, "_settle_login", lambda *_a: None)
    monkeypatch.setattr(publisher, "_is_logged_in", lambda *_a: True)
    monkeypatch.setattr(publisher, "_readback_capture", lambda *_a: set())
    monkeypatch.setattr(publisher, "_resolve_steps", lambda *_a: [])

    def submit(_page, _ctx):
        _page.url = channels.MANAGE_URL
        return NOW_MS

    monkeypatch.setattr(publisher, "_publish_weixin_channels", submit)
    seen = []

    def verify(_platform, _page, **kwargs):
        seen.append(kwargs)
        return readback.ReadbackResult("verified", channels.map_work(raw_work(handleStatus=handle_status)))

    monkeypatch.setattr(publisher, "_readback_verify", verify)
    import calendar_ops
    recorded = []
    monkeypatch.setattr(calendar_ops, "record_publish", lambda *_a, **kw: recorded.append(kw))
    media = tmp_path / "mock.mp4"
    media.write_bytes(b"fake media; browser is mocked")
    args = cli_args(tmp_path, media=str(media), desc="正文", tags="", cover=None, exec=True,
                    allow_unsafe=False, keep_open=False)
    code = publisher.cmd_publish(args)
    receipt = get_receipt(capsys)
    assert receipt["outcome"] == outcome and receipt["url"] == ""
    assert len(recorded) == int(outcome == "published")
    assert seen[0]["since_ms"] == NOW_MS
    assert (code == 0) is (outcome in {"published", "submitted"})
