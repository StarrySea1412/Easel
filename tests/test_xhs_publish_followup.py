"""Offline XHS creator readback contracts; never log in, publish, or send mail."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills" / "shared" / "scripts"))

import publish_receipt
import xhs_publish as publisher
import xhs_readback as rb

NOW = 1_791_510_400_000
NOTE_ID = "6a6aba4d00000000090350b1"
OTHER_ID = "6a6aba4d00000000090350b2"
RID = "a1" * 16
TITLE = "本次笔记的精确标题"
LIST_URL = "https://creator.xiaohongshu.com" + rb.LIST_PATH + "?tab=0&page=0"


@pytest.fixture(autouse=True)
def deterministic_environment(monkeypatch):
    monkeypatch.setenv("EASEL_PUBLISH_RECEIPT_ID", RID)
    monkeypatch.setenv("EASEL_CALENDAR_AUTORECORD", "0")
    monkeypatch.setattr(rb.time, "time", lambda: NOW / 1000)


def note():
    return dict(id=NOTE_ID, display_title=TITLE, tab_status=1, permission_code=0,
                high_self=0, schedule_post_time=0, time=NOW)


def note_with(**changes):
    value = note()
    value.update(changes)
    return value


def response_body(*notes, **changes):
    value = {"success": True, "code": 0, "data": {"notes": list(notes), "page": -1}}
    value.update(changes)
    return value


def receipt_output(capsys):
    lines = capsys.readouterr().out.splitlines()
    framed = [line[len(publish_receipt.PREFIX):] for line in lines if line.startswith(publish_receipt.PREFIX)]
    assert len(framed) == 1 and framed[0].isascii()
    receipt = json.loads(framed[0])
    assert receipt["receiptId"] == RID and receipt["platform"] == "xiaohongshu"
    return receipt


@pytest.mark.parametrize("changes,status", [
    ({}, "published"), ({"high_self": False}, "published"),
    ({"tab_status": 2}, "reviewing"), ({"tab_status": 3}, "rejected"),
    ({"tab_status": 4}, "scheduled"), ({"schedule_post_time": NOW + 60000}, "scheduled"),
    ({"post_timing": True}, "scheduled"), ({"post_timing": False}, "published"),
    ({"permission_code": 1}, "private"), ({"permission_code": 2}, "private"),
    ({"permission_code": 3}, "private"), ({"permission_code": 4}, "private"),
    ({"high_self": 1}, "private"), ({"high_self": True}, "private"),
    ({"tab_status": 0}, "unknown"), ({"tab_status": 99}, "unknown"),
    ({"tab_status": "1"}, "unknown"), ({"tab_status": True}, "unknown"),
    ({"permission_code": False}, "unknown"), ({"permission_code": "0"}, "unknown"),
    ({"permission_code": 99}, "unknown"), ({"permission_msg": "仅自己可见"}, "unknown"),
    ({"schedule_post_time": False}, "unknown"), ({"schedule_post_time": "0"}, "unknown"),
    ({"high_self": "0"}, "unknown"), ({"high_self": 2}, "unknown"),
])
def test_first_party_status_requires_explicit_public_visibility(changes, status):
    assert rb.normalize_status(note_with(**changes)) == status


@pytest.mark.parametrize("field", ["tab_status", "permission_code", "schedule_post_time", "high_self"])
def test_missing_public_evidence_is_not_defaulted_to_zero(field):
    raw = note()
    del raw[field]
    assert rb.normalize_status(raw) == "unknown"


@pytest.mark.parametrize("changes", [
    {"id": "../secret"}, {"id": "shortid"}, {"id": None}, {"display_title": None},
])
def test_malformed_work_identity_is_ignored(changes):
    assert rb.map_note(note_with(**changes)) is None


@pytest.mark.parametrize("timestamp", [None, True, "1791510400000", 1791510400, 1.0,
                                         float("nan"), float("inf"), "2026-10-09 12:34"])
def test_imprecise_or_untyped_time_cannot_identify_a_new_publish(timestamp):
    work = rb.map_note(note_with(time=timestamp))
    assert work is not None and work.published_at_ms is None
    assert rb.find_xhs_work([work], title=TITLE, since_ms=NOW) is None


def test_parser_uses_only_the_known_creator_notes_envelope():
    data = response_body(note())
    data["metadata"] = {"notes": [note_with(id=OTHER_ID)]}
    works = rb.parse_list_response(data)
    assert len(works) == 1 and works[0].platform_content_id == NOTE_ID
    assert rb.parse_list_response(response_body()) == []
    with pytest.raises(RuntimeError):
        rb.parse_list_response({"success": True, "data": {"search": {"notes": [note()]}}})


@pytest.mark.parametrize("body", [
    {"success": False, "code": 0, "data": {"notes": [note()]}},
    {"success": True, "code": False, "data": {"notes": [note()]}},
    {"success": True, "code": 99, "data": {"notes": [note()]}},
    {"data": {"notes": [note()]}},
    {"success": True, "data": {"notes": "bad"}},
])
def test_errors_do_not_launder_embedded_public_records(body):
    with pytest.raises(RuntimeError):
        rb.parse_list_response(body)


def test_login_error_is_distinct_from_unknown_api_errors():
    with pytest.raises(rb.LoginRequiredError):
        rb.parse_list_response({"code": -1, "message": "请先登录", "data": {"notes": [note()]}})


@pytest.mark.parametrize("snapshot", [None, set(), {OTHER_ID}])
def test_title_lookup_never_widens_the_one_second_window(snapshot):
    old = rb.map_note(note_with(time=NOW - 1001))
    future = rb.map_note(note_with(time=NOW + 1001))
    boundary = rb.map_note(note_with(time=NOW - 1000))
    assert rb.find_xhs_work([old, future], title=TITLE, since_ms=NOW, snapshot_ids=snapshot) is None
    assert rb.find_xhs_work([boundary], title=TITLE, since_ms=NOW, snapshot_ids=snapshot) is boundary


def test_snapshot_excludes_preexisting_work_and_same_titles_are_ambiguous():
    first = rb.map_note(note())
    second = rb.map_note(note_with(id=OTHER_ID))
    assert rb.find_xhs_work([first], title=TITLE, since_ms=NOW, snapshot_ids={NOTE_ID}) is None
    assert rb.find_xhs_work([first, second], title=TITLE, since_ms=NOW) is None
    assert rb.find_xhs_work([first, first], title=TITLE, since_ms=NOW) is None
    assert rb.find_xhs_work([first, second], title=TITLE, since_ms=NOW, snapshot_ids={NOTE_ID}) is second


def test_known_id_does_not_fall_back_to_a_different_same_title_work():
    first = rb.map_note(note())
    second = rb.map_note(note_with(id=OTHER_ID))
    assert rb.find_xhs_work([second], title=TITLE, since_ms=NOW, content_id=NOTE_ID) is None
    assert rb.find_xhs_work([second, first], title=TITLE, since_ms=NOW, content_id=NOTE_ID) is first
    assert rb.find_xhs_work([first], title=TITLE + "不同结尾", since_ms=NOW, content_id=NOTE_ID) is first


def test_known_id_remains_stable_if_platform_title_or_date_changes():
    work = rb.map_note(note_with(display_title="审核期间修改的新标题", time=None))
    assert rb.find_xhs_work([work], title=TITLE, since_ms=NOW, content_id=NOTE_ID) is work
    assert rb.find_xhs_work([work, work], title=TITLE, since_ms=NOW, content_id=NOTE_ID) is None


def test_original_submission_window_rejects_a_later_same_title_republish():
    since, until = NOW - 600000, NOW - 540000
    original = rb.map_note(note_with(time=since + 15000))
    republished = rb.map_note(note_with(id=OTHER_ID, time=NOW - 5000))
    assert rb.find_xhs_work([republished], title=TITLE, since_ms=since, until_ms=until) is None
    assert rb.find_xhs_work([republished, original], title=TITLE, since_ms=since, until_ms=until) is original
    # Explicit legacy CLI calls without the optional bound preserve their old behavior.
    assert rb.find_xhs_work([republished], title=TITLE, since_ms=since) is republished


@pytest.mark.parametrize("delta,accepted", [(0, True), (1000, True), (1001, False)])
def test_submission_end_allows_at_most_one_second_precision(delta, accepted):
    until = NOW - 300000
    work = rb.map_note(note_with(time=until + delta))
    result = rb.find_xhs_work([work], title=TITLE, since_ms=until - 60000, until_ms=until)
    assert (result is work) is accepted


def test_known_id_does_not_apply_an_earlier_title_lookup_window():
    work = rb.map_note(note_with(display_title="修改后的标题", time=NOW))
    assert rb.find_xhs_work([work], title=TITLE, since_ms=NOW - 600000,
                            until_ms=NOW - 540000, content_id=NOTE_ID) is work


@pytest.mark.parametrize("until", [True, False, 0, -1, 1791510400, "1791510400000", NOW - 1,
                                     float("nan"), float("inf")])
def test_invalid_end_or_reversed_submission_window_is_rejected(until):
    assert rb.find_xhs_work([rb.map_note(note())], title=TITLE, since_ms=NOW, until_ms=until) is None


@pytest.mark.parametrize("since", [True, None, 0, -1, 1791510400, "1791510400000", NOW + 1001])
def test_invalid_since_does_not_disable_matching_time_requirement(since):
    assert rb.find_xhs_work([rb.map_note(note())], title=TITLE, since_ms=since) is None


class Response:
    def __init__(self, body, *, url=LIST_URL, status=200, method="GET"):
        self.url = url
        self.status = status
        self.request = SimpleNamespace(method=method)
        self.body = body

    def json(self):
        if isinstance(self.body, Exception):
            raise self.body
        return self.body


class ReadOnlyPage:
    """Only read primitives exist: accidental clicks or uploads fail the test."""
    def __init__(self, responses=(), landing_url=rb.MANAGE_URL):
        self.responses = list(responses)
        self.landing_url = landing_url
        self.url = "about:blank"
        self.listeners = []
        self.calls = []

    def on(self, event, fn):
        assert event == "response"
        self.listeners.append(fn)

    def remove_listener(self, event, fn):
        assert event == "response"
        self.listeners.remove(fn)

    def goto(self, url, **_kwargs):
        assert url == rb.MANAGE_URL
        self.calls.append(("goto", url))
        self.url = self.landing_url
        for response in self.responses:
            for fn in self.listeners:
                fn(response)

    def wait_for_timeout(self, milliseconds):
        self.calls.append(("wait", milliseconds))


def test_readback_captures_only_the_current_accounts_get_list_and_removes_listener():
    page = ReadOnlyPage([Response(response_body(note()))])
    result = rb.verify_xhs_publish(page, title=TITLE, since_ms=NOW, attempts=1)
    assert result.outcome == "verified" and result.matched.status == "published"
    assert page.listeners == []
    assert all(name in {"goto", "wait"} for name, _ in page.calls)


def test_verifier_threads_submission_end_into_matching_and_receipt_evidence():
    since, until = NOW - 600000, NOW - 540000
    page = ReadOnlyPage([Response(response_body(note()))])
    result = rb.verify_xhs_publish(page, title=TITLE, since_ms=since, until_ms=until, attempts=1)
    receipt = rb.receipt_from_result(result, read_only=True)
    assert result.outcome == "unverified" and result.matched is None
    assert receipt["evidence"]["untilMs"] == until
    assert receipt["outcome"] == "unverified" and receipt["url"] == ""


def test_invalid_submission_end_is_rejected_before_browser_navigation():
    page = ReadOnlyPage([Response(response_body(note()))])
    result = rb.verify_xhs_publish(page, title=TITLE, since_ms=NOW, until_ms=NOW - 1)
    assert result.outcome == "unverified" and not page.calls


@pytest.mark.parametrize("url", [
    "https://creator.xiaohongshu.com.attacker.invalid" + rb.LIST_PATH + "?tab=0&page=0",
    "https://attacker.invalid/" + LIST_URL,
    LIST_URL.replace("https:", "http:"),
    LIST_URL.replace("creator.xiaohongshu.com", "user:password@creator.xiaohongshu.com"),
    LIST_URL.replace("creator.xiaohongshu.com", "creator.xiaohongshu.com:443"),
    LIST_URL.replace("tab=0", "tab=1"),
    LIST_URL.replace("page=0", "page=1"),
    LIST_URL + "&tab=1",
    LIST_URL.replace(rb.LIST_PATH, "/api/unknown/notes"),
])
def test_foreign_or_wrong_scope_responses_never_prove_publication(url):
    page = ReadOnlyPage([Response(response_body(note()), url=url)])
    with pytest.raises(RuntimeError):
        rb.read_xhs_works(page, wait_ms=250)
    assert page.listeners == []


@pytest.mark.parametrize("status,method,outcome", [(401, "GET", "login_required"),
                                                   (403, "GET", "readback_error"),
                                                   (200, "POST", "readback_error")])
def test_response_auth_and_method_failures_are_not_published(status, method, outcome):
    page = ReadOnlyPage([Response(response_body(note()), status=status, method=method)])
    assert rb.verify_xhs_publish(page, title=TITLE, since_ms=NOW, attempts=1).outcome == outcome
    assert not page.listeners


def test_login_redirect_discards_even_a_previously_captured_record():
    page = ReadOnlyPage([Response(response_body(note()))], landing_url="https://creator.xiaohongshu.com/login")
    result = rb.verify_xhs_publish(page, title=TITLE, since_ms=NOW, attempts=1)
    assert result.outcome == "login_required" and result.matched is None
    assert not page.listeners


def test_failed_snapshot_is_distinct_from_a_successfully_observed_empty_account():
    assert rb.capture_xhs_snapshot(ReadOnlyPage([Response(response_body())])) == set()
    assert rb.capture_xhs_snapshot(ReadOnlyPage([Response(ValueError("session-secret"))])) is None


def test_readback_retries_are_bounded_and_errors_are_not_copied_to_receipts():
    page = ReadOnlyPage([Response(ValueError("https://host/?token=private-token"))])
    result = rb.verify_xhs_publish(page, title=TITLE, since_ms=NOW, attempts=99, delay_s=0)
    receipt = rb.receipt_from_result(result, read_only=True)
    assert len([call for call in page.calls if call[0] == "goto"]) == 4
    assert receipt["outcome"] == "unverified" and receipt["url"] == ""
    assert "private-token" not in json.dumps(receipt)


def install_fake_browser(monkeypatch, page):
    context = SimpleNamespace(pages=[page], closed=False)

    def close():
        context.closed = True

    context.close = close

    class Playwright:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

    module = ModuleType("playwright.sync_api")
    module.sync_playwright = Playwright
    module.TimeoutError = TimeoutError
    monkeypatch.setitem(sys.modules, "playwright.sync_api", module)
    monkeypatch.setitem(sys.modules, "playwright", ModuleType("playwright"))
    launch_calls = []

    def launch(_pw, **kwargs):
        launch_calls.append(kwargs)
        return context

    monkeypatch.setattr(publisher, "_launch", launch)
    return context, launch_calls


def verify_args(**changes):
    args = dict(title=TITLE, since_ms=NOW, content_id=NOTE_ID, profile_base="test-profile-root",
                headed=True, proxy="http://proxy.invalid:3128", no_proxy=False)
    args.update(changes)
    return SimpleNamespace(**args)


@pytest.mark.parametrize("changes,outcome", [({}, "published"), ({"tab_status": 2}, "submitted"),
                                            ({"permission_code": 1}, "unverified"),
                                            ({"tab_status": 3}, "failed"),
                                            ({"tab_status": 900}, "unverified")])
def test_cli_recheck_is_read_only_and_inherits_receipt_identity(monkeypatch, capsys, changes, outcome):
    page = ReadOnlyPage([Response(response_body(note_with(**changes)))])
    context, calls = install_fake_browser(monkeypatch, page)

    def no_publishing(*_args, **_kwargs):
        raise AssertionError("Read-only verification must not call a publishing operation")

    for name in ("_publish", "_fill_and_submit", "_upload_images", "_upload_video", "_click_publish_tab"):
        monkeypatch.setattr(publisher, name, no_publishing)
    code = publisher.cmd_verify_publish(verify_args())
    receipt = receipt_output(capsys)
    assert receipt["outcome"] == outcome
    assert receipt["evidence"]["readOnly"] is True
    assert receipt["evidence"]["publicAccessChecked"] is False
    assert receipt["evidence"]["sinceMs"] == NOW
    assert bool(receipt["url"]) is (outcome == "published")
    assert (code == 0) is (outcome in {"submitted", "published"})
    assert context.closed
    assert calls == [{"headed": True, "base": "test-profile-root", "proxy": "http://proxy.invalid:3128"}]


def test_recheck_launch_failure_keeps_an_earlier_publish_unverified(monkeypatch, capsys):
    install_fake_browser(monkeypatch, ReadOnlyPage())

    def broken_launch(*_args, **_kwargs):
        raise RuntimeError("session-secret")

    monkeypatch.setattr(publisher, "_launch", broken_launch)
    assert publisher.cmd_verify_publish(verify_args()) == 5
    receipt = receipt_output(capsys)
    assert receipt["outcome"] == "unverified" and "session-secret" not in json.dumps(receipt)


@pytest.mark.parametrize("tail", [
    [], ["--title", TITLE], ["--title", TITLE, "--since-ms", "1791510400"],
    ["--title", TITLE, "--since-ms", str(NOW), "--exec"],
    ["--title", TITLE, "--since-ms", str(NOW), "--content-id", "../bad"],
    ["--title", TITLE, "--since-ms", "NaN"],
    ["--title", TITLE, "--since-ms", str(NOW), "--until-ms", str(NOW - 1)],
    ["--title", TITLE, "--since-ms", str(NOW), "--until-ms", "1791510400"],
])
def test_recheck_parser_requires_valid_read_only_arguments(monkeypatch, tail):
    monkeypatch.setattr(sys, "argv", ["xhs_publish.py", "verify-publish", *tail])
    with pytest.raises(SystemExit) as exc:
        publisher.main()
    assert exc.value.code == 2


def test_recheck_parser_accepts_an_empty_content_id_without_exec(monkeypatch):
    seen = []
    monkeypatch.setattr(publisher, "cmd_verify_publish", lambda args: seen.append(args) or 0)
    monkeypatch.setattr(sys, "argv", ["xhs_publish.py", "verify-publish", "--title", TITLE,
                                    "--since-ms", str(NOW), "--content-id", "", "--no-proxy"])
    assert publisher.main() == 0
    assert seen[0].content_id == "" and seen[0].no_proxy and not hasattr(seen[0], "exec")


def test_recheck_cli_passes_the_optional_submission_end(monkeypatch, capsys):
    page = ReadOnlyPage([Response(response_body(note()))])
    install_fake_browser(monkeypatch, page)
    monkeypatch.setattr(sys, "argv", ["xhs_publish.py", "verify-publish", "--title", TITLE,
                                    "--since-ms", str(NOW - 600000), "--until-ms", str(NOW - 540000)])
    assert publisher.main() == 5
    receipt = receipt_output(capsys)
    assert receipt["outcome"] == "unverified" and receipt["evidence"]["untilMs"] == NOW - 540000


@pytest.mark.parametrize("signal", ["success_message", "form_reset", "page_navigation"])
def test_ui_signal_never_overrides_private_or_unknown_readback(signal):
    for status in ("private", "unknown"):
        work = rb.WorkItem(NOTE_ID, TITLE, status, NOW)
        receipt = rb.receipt_from_result(rb.ReadbackResult("verified", work), signal=signal)
        assert receipt["outcome"] == "unverified" and receipt["url"] == ""


def test_provenance_drops_arbitrary_data_including_tokens():
    result = rb.ReadbackResult("unverified", evidence={"snapshotCount": "private-token", "attempts": True,
                                                      "matchedBy": "private-token", "raw": "private-token"})
    assert "private-token" not in json.dumps(rb.receipt_from_result(result))


class PublishPage(ReadOnlyPage):
    def goto(self, url, **_kwargs):
        self.calls.append(("goto", url))
        self.url = url

    def set_default_timeout(self, *_args):
        pass


def setup_publish(monkeypatch, tmp_path):
    page = PublishPage()
    context, _calls = install_fake_browser(monkeypatch, page)
    monkeypatch.setattr(publisher, "_query_safe", lambda *_args: object())
    monkeypatch.setattr(publisher, "_click_publish_tab", lambda *_args: None)
    monkeypatch.setattr(publisher, "_upload_images", lambda *_args: None)
    media = tmp_path / "image.png"
    media.write_bytes(b"fixture only; browser is fake")
    args = verify_args(exec=True, images=str(media), video=None, content="测试正文", tags="",
                       keep_open=False, no_proxy=True, allow_unsafe=False)
    return args, page, context


@pytest.mark.parametrize("ui_error", [False, True])
def test_original_publish_takes_snapshot_and_reads_result_even_after_ui_timeout(monkeypatch, tmp_path, capsys, ui_error):
    args, page, context = setup_publish(monkeypatch, tmp_path)
    order = []

    def snapshot(_page):
        assert _page is page
        order.append("snapshot")
        return {OTHER_ID}

    def submit(_page, _title, _content, _tags, *, before_submit):
        order.append("submit")
        before_submit()
        publish_receipt.mark_submitted()
        if ui_error:
            raise SystemExit(1)
        return "success_message"

    def verify(_page, **kwargs):
        order.append("verify")
        assert kwargs == {"title": TITLE, "since_ms": NOW, "snapshot_ids": {OTHER_ID}}
        return rb.ReadbackResult("verified", rb.map_note(note()))

    monkeypatch.setattr(rb, "capture_xhs_snapshot", snapshot)
    monkeypatch.setattr(publisher, "_fill_and_submit", submit)
    monkeypatch.setattr(rb, "verify_xhs_publish", verify)
    assert publisher.cmd_publish(args) == 0
    receipt = receipt_output(capsys)
    assert receipt["outcome"] == "published"
    assert order == ["snapshot", "submit", "verify"] and context.closed


def test_failure_before_publish_does_not_run_a_readback_or_retry_submission(monkeypatch, tmp_path, capsys):
    args, _page, context = setup_publish(monkeypatch, tmp_path)
    monkeypatch.setattr(rb, "capture_xhs_snapshot", lambda _page: None)

    def fail_before_click(*_args, **_kwargs):
        raise SystemExit(1)

    def should_not_verify(*_args, **_kwargs):
        raise AssertionError("No submission was attempted")

    monkeypatch.setattr(publisher, "_fill_and_submit", fail_before_click)
    monkeypatch.setattr(rb, "verify_xhs_publish", should_not_verify)
    with pytest.raises(SystemExit):
        publisher.cmd_publish(args)
    receipt = receipt_output(capsys)
    assert receipt["outcome"] == "failed" and context.closed


def test_dry_run_does_not_open_a_browser_or_emit_a_receipt(monkeypatch, tmp_path, capsys):
    args, _page, context = setup_publish(monkeypatch, tmp_path)
    args.exec = False

    def no_browser(*_args, **_kwargs):
        raise AssertionError("Dry-run must remain offline")

    monkeypatch.setattr(publisher, "_launch", no_browser)
    assert publisher.cmd_publish(args) == 0
    assert publish_receipt.PREFIX not in capsys.readouterr().out and not context.closed
