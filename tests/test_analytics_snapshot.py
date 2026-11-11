"""Growth windows must only ever compare a platform account with itself.

`较昨日/较上周/较上月/较去年` used to be produced from a platform-level snapshot
file, so switching accounts in the same browser profile (or a shared file on
disk) could present another account's follower count as this account's growth.
These tests pin the ownership rule and the daily worker that creates a real
baseline instead of relying on the user refreshing the page.
"""
import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills" / "shared" / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "web"))
import account_stats
import analytics_snapshot


@pytest.fixture()
def analytics_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(account_stats, "ANALYTICS_DIR", tmp_path / "_analytics")
    return tmp_path / "_analytics"


def test_growth_is_scoped_per_platform_account(analytics_dir):
    now = int(time.time())
    day = 86400
    account_stats.record_snapshot("bilibili", {"ts": now - 8 * day, "followers": 100, "likes": 10, "posts": 3},
                                  "mid-a")
    # Same order as the fetch endpoint: read history, compute growth, then record.
    current = {"ts": now, "followers": 130, "likes": 12, "posts": 4}
    growth = account_stats.growth_windows(account_stats.load_history("bilibili", "mid-a"), current)
    account_stats.record_snapshot("bilibili", current, "mid-a")
    # A different account on the same platform starts with no history at all.
    account_stats.record_snapshot("bilibili", {"ts": now, "followers": 999, "likes": 99, "posts": 9}, "mid-b")

    history_a = account_stats.load_history("bilibili", "mid-a")
    assert [row["followers"] for row in history_a] == [100, 130]
    assert growth["week"]["followers"] == 30
    assert growth["last"]["followers"] == 30

    history_b = account_stats.load_history("bilibili", "mid-b")
    assert [row["followers"] for row in history_b] == [999]
    # No baseline for the new account: null, never account A's numbers.
    assert account_stats.growth_windows(history_b, {"ts": now, "followers": 999, "likes": 99, "posts": 9})["week"] is None


def test_history_without_account_id_is_never_a_baseline(analytics_dir):
    now = int(time.time())
    analytics_dir.mkdir(parents=True, exist_ok=True)
    # A legacy platform-level file (written before accounts were separated).
    (analytics_dir / "bilibili.jsonl").write_text(
        json.dumps({"ts": now - 8 * 86400, "followers": 5000, "likes": 1, "posts": 1}) + "\n", encoding="utf-8")

    assert account_stats.load_history("bilibili") == []
    account_stats.record_snapshot("bilibili", {"ts": now, "followers": 7, "likes": 1, "posts": 1})
    # Unattributed writes are refused rather than appended to the legacy file.
    assert (analytics_dir / "bilibili.jsonl").read_text(encoding="utf-8").count("\n") == 1


def test_clear_analytics_removes_account_scoped_history(analytics_dir):
    now = int(time.time())
    account_stats.record_snapshot("douyin", {"ts": now - 86400, "followers": 10, "likes": 1, "posts": 1}, "uid-1")
    account_stats.record_snapshot("douyin", {"ts": now, "followers": 12, "likes": 1, "posts": 1}, "uid-1")
    assert account_stats.load_history("douyin", "uid-1")

    account_stats.clear_analytics("douyin")

    assert account_stats.load_history("douyin", "uid-1") == []
    assert not (analytics_dir / "douyin-accounts").exists()


class _Worker(analytics_snapshot.SnapshotService):
    """Deterministic clock so "one collection per local day" is testable."""

    def __init__(self, root, **kwargs):
        self.clock = kwargs.pop("clock")
        super().__init__(root, now=lambda: self.clock(), **kwargs)


def test_daily_worker_collects_once_per_day_for_logged_in_platforms(tmp_path):
    clock = [time.time()]
    calls = []
    worker = _Worker(tmp_path, platforms=["bilibili", "douyin"],
                     logged_in=lambda pf: pf == "bilibili",
                     collect=lambda pf: calls.append(pf) or True,
                     interval=0, initial_delay=0, clock=lambda: clock[0])

    assert worker.tick() == 1
    assert calls == ["bilibili"]
    # A second tick the same local day must not launch another browser.
    assert worker.tick() == 0
    assert calls == ["bilibili"]

    clock[0] += 86400
    assert worker.tick() == 1
    assert calls == ["bilibili", "bilibili"]
    status = worker.status()["platforms"]["bilibili"]
    assert status["error"] == ""


def test_daily_worker_records_failure_and_keeps_trying(tmp_path):
    attempts = []

    def collect(platform):
        attempts.append(platform)
        raise RuntimeError("browser did not start")

    worker = analytics_snapshot.SnapshotService(tmp_path, platforms=["zhihu"], logged_in=lambda pf: True,
                                                collect=collect, interval=0, initial_delay=0)
    assert worker.tick() == 0
    assert worker.tick() == 0
    assert len(attempts) == 2
    entry = worker.status()["platforms"]["zhihu"]
    assert "browser did not start" in entry["error"]
    assert entry["day"] is None


def test_daily_worker_stops_after_repeated_failures_same_day(tmp_path):
    attempts = []
    worker = analytics_snapshot.SnapshotService(
        tmp_path, platforms=["zhihu"], logged_in=lambda pf: True,
        collect=lambda pf: attempts.append(pf) or (_ for _ in ()).throw(RuntimeError("boom")),
        interval=0, initial_delay=0)
    for _ in range(analytics_snapshot.MAX_ATTEMPTS_PER_DAY + 3):
        worker.tick()
    assert len(attempts) == analytics_snapshot.MAX_ATTEMPTS_PER_DAY


def test_daily_worker_skips_platforms_that_are_not_logged_in(tmp_path):
    calls = []
    worker = analytics_snapshot.SnapshotService(tmp_path, platforms=["kuaishou"], logged_in=lambda pf: False,
                                                collect=lambda pf: calls.append(pf) or True,
                                                interval=0, initial_delay=0)
    assert worker.tick() == 0
    assert calls == []
    # Not logged in is not a failure: no error recorded, so it retries once logged in.
    assert "kuaishou" not in worker.status()["platforms"]


def test_corrupt_state_file_does_not_stop_collection(tmp_path):
    (tmp_path / "state.json").write_text("{not json", encoding="utf-8")
    calls = []
    worker = analytics_snapshot.SnapshotService(tmp_path, platforms=["douyin"], logged_in=lambda pf: True,
                                                collect=lambda pf: calls.append(pf) or True,
                                                interval=0, initial_delay=0)
    assert worker.tick() == 1
    assert calls == ["douyin"]


# --------------------------------------------------------------------------- #
# 七个分析平台的账号归属键逐个钉住。
# 每个平台拿归属键的途径不同：页面账号标签（抖音/快手/知乎/视频号）、小红书号、
# B站 nav 接口的 mid、公众号后台 user_name。任一条路径失效，增长窗口就只能
# 拿别人的数据当基线，所以不能只测一个平台就认为「已联动」。
# --------------------------------------------------------------------------- #

_LABEL_PLATFORMS = [
    ("douyin", "抖音号：douyin_88", "douyin_88"),
    ("kuaishou", "快手号：ks_777", "ks_777"),
    ("zhihu", "知乎号：zh_999", "zh_999"),
    ("weixin-channels", "视频号ID: sphAbc123xyz", "sphAbc123xyz"),
]


@pytest.mark.parametrize("platform,line,expected", _LABEL_PLATFORMS)
def test_account_id_is_extracted_from_the_platform_label(platform, line, expected):
    pattern = account_stats.PLATFORMS[platform]["id_regex"]
    assert account_stats.extract_account_id([line], pattern) == expected
    # 页面上没有账号标签时必须返回空：空归属键会阻止快照落盘，而不是猜一个。
    assert account_stats.extract_account_id(["没有任何账号标签"], pattern) == ""


def test_xiaohongshu_account_id_comes_from_the_creator_label_only():
    assert account_stats.extract_xhs_account_id(["小红书号：abc123"]) == "abc123"
    # 昵称可以改，不是账号标识，不能当归属键。
    assert account_stats.extract_xhs_account_id(["张三的小红书"]) == ""
    # 页面出现两个互相矛盾的账号号 → 归属不可信，宁可没有增长。
    assert account_stats.extract_xhs_account_id(["小红书号：abc123", "小红书号：xyz789"]) == ""


@pytest.mark.parametrize("platform", ["douyin", "kuaishou", "zhihu", "weixin-channels"])
def test_playwright_platforms_keep_history_per_account(analytics_dir, platform):
    now = int(time.time())
    day = 86400
    account_stats.record_snapshot(platform, {"ts": now - 8 * day, "followers": 100, "likes": 1, "posts": 1}, "acct-a")
    current = {"ts": now, "followers": 130, "likes": 2, "posts": 2}
    growth = account_stats.growth_windows(account_stats.load_history(platform, "acct-a"), current)
    account_stats.record_snapshot(platform, current, "acct-a")
    account_stats.record_snapshot(platform, {"ts": now, "followers": 999, "likes": 9, "posts": 9}, "acct-b")

    assert [row["followers"] for row in account_stats.load_history(platform, "acct-a")] == [100, 130]
    assert growth["week"]["followers"] == 30
    assert [row["followers"] for row in account_stats.load_history(platform, "acct-b")] == [999]
    assert account_stats.growth_windows(
        account_stats.load_history(platform, "acct-b"),
        {"ts": now, "followers": 999, "likes": 9, "posts": 9})["week"] is None


def test_xiaohongshu_history_follows_the_verified_evidence_account(analytics_dir):
    """小红书没有账号 ID 参数：归属来自 evidence 里已核验的当前账号。"""
    import account_evidence as evidence

    now = int(time.time())
    evidence.ingest(analytics_dir, [{"note_id": "abc123def"}], "xhsacct01", now, source="live", name="A")
    account_stats.record_snapshot("xiaohongshu", {"ts": now, "followers": 10, "likes": 1, "posts": 1})
    assert [row["followers"] for row in account_stats.load_history("xiaohongshu")] == [10]

    # 换号后旧账号的快照不再是基线：新账号从零开始攒。
    evidence.ingest(analytics_dir, [{"note_id": "xyz789ghi"}], "xhsacct02", now + 60, source="live", name="B")
    assert account_stats.load_history("xiaohongshu") == []
    account_stats.record_snapshot("xiaohongshu", {"ts": now + 120, "followers": 777, "likes": 7, "posts": 7})
    assert [row["followers"] for row in account_stats.load_history("xiaohongshu")] == [777]


def test_bilibili_account_id_is_the_verified_mid(tmp_path):
    """B站不用浏览器 profile，归属键是 cookie 里的 mid（再由 nav 接口核验）。"""
    import bili_login

    cookie = tmp_path / "cookies.json"
    cookie.write_text(json.dumps({"token_info": {"mid": 12345, "access_token": "t"}}), encoding="utf-8")
    _, mid = bili_login._load_cookie(cookie)
    assert mid == 12345
    # 没有 cookie 文件就没有归属键（0），调用方据此拒绝写入快照。
    _, missing = bili_login._load_cookie(tmp_path / "absent.json")
    assert missing == 0


def test_wechat_oa_account_id_is_the_backend_user_name():
    """公众号归属键是 mp 后台服务端渲染的 user_name（gh_ 开头）。"""
    import weixin_mp_stats

    class _Page:
        def __init__(self, html):
            self._html = html

        def content(self):
            return self._html

    assert weixin_mp_stats._extract_account_id(_Page('{"user_name":"gh_abc12345"}')) == "gh_abc12345"
    assert weixin_mp_stats._extract_account_id(_Page("这里没有账号标识")) == ""
    # 两个 gh_ 说明页面归属不明，不能猜一个写进基线。
    assert weixin_mp_stats._extract_account_id(_Page("gh_aaaaaaaa1 gh_bbbbbbbb2")) == ""


def test_account_id_falls_back_to_the_platform_api_when_the_page_has_no_label():
    """知乎创作中心不渲染「知乎号」，正文抽不到归属键；后备接口必须给出本人的稳定标识。

    后备只在页面抽取为空时使用，且拿不到/字段不合法一律返回空串——空归属键会阻止快照落盘，
    而不是拿一个猜来的 ID 当基线。
    """
    cfg = {"id_api": {"url": "/api/v4/me", "field": "url_token"}}

    class _Page:
        def __init__(self, result=None, boom=False):
            self.result = result
            self.boom = boom
            self.calls = []

        def evaluate(self, script, arg):
            self.calls.append(arg)
            if self.boom:
                raise RuntimeError("navigation lost")
            return self.result

    page = _Page("wwe-1-89")
    assert account_stats.account_id_from_api(page, cfg) == "wwe-1-89"
    # 只查配置里的接口和字段，不从页面文本猜。
    assert page.calls == [["/api/v4/me", "url_token"]]

    # 接口没返回该字段 / 不是字符串 / 接口报错 → 没有归属键，宁可没有增长。
    assert account_stats.account_id_from_api(_Page(None), cfg) == ""
    assert account_stats.account_id_from_api(_Page(12345), cfg) == ""
    assert account_stats.account_id_from_api(_Page(boom=True), cfg) == ""
    # 不合法的标识（空白、含空格、超长）不能当归属键。
    assert account_stats.account_id_from_api(_Page("  "), cfg) == ""
    assert account_stats.account_id_from_api(_Page("has space"), cfg) == ""
    assert account_stats.account_id_from_api(_Page("x" * 65), cfg) == ""
    # 没配 id_api 的平台完全不发起请求。
    unused = _Page("should-not-be-read")
    assert account_stats.account_id_from_api(unused, {}) == ""
    assert unused.calls == []


def test_zhihu_declares_the_me_endpoint_as_its_account_source():
    """知乎必须配 id_api，否则真机上 accountId 恒为空、快照永不落盘（真机 2026-11 校准）。"""
    cfg = account_stats.PLATFORMS["zhihu"]
    assert cfg["id_api"] == {"url": "/api/v4/me", "field": "url_token"}
    # 正文正则仍保留：页面若将来渲染出「知乎号」，优先用页面证据。
    assert account_stats.extract_account_id(["知乎号：zh_999"], cfg["id_regex"]) == "zh_999"


def test_concurrent_collectors_do_not_lose_snapshots(analytics_dir):
    """每日自动快照 worker 与手动 fetch 是两个进程，会同时写同一个账号文件。

    「读历史 → 合并 → 写回」没有互斥时，后写的进程会拿自己读到的旧历史覆盖对方刚追加的那条，
    基线就凭空少一天。这里用真实多进程并发写同一账号，断言一条都不丢。
    """
    import subprocess

    scripts_dir = Path(account_stats.__file__).resolve().parent
    program = (
        "import sys\n"
        "from pathlib import Path\n"
        "sys.path.insert(0, sys.argv[1])\n"
        "import account_stats\n"
        "account_stats.ANALYTICS_DIR = Path(sys.argv[2])\n"
        "ts = int(sys.argv[3])\n"
        "account_stats.record_snapshot('douyin', {'ts': ts, 'followers': ts, 'likes': 1, 'posts': 1}, 'uid-race')\n"
    )
    now = int(time.time())
    writers = 6
    procs = [
        subprocess.Popen([sys.executable, "-c", program, str(scripts_dir), str(analytics_dir), str(now - i)],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for i in range(writers)
    ]
    for proc in procs:
        _, err = proc.communicate(timeout=180)
        assert proc.returncode == 0, err.decode("utf-8", "replace")

    rows = account_stats.load_history("douyin", "uid-race")
    assert len(rows) == writers, f"并发写入丢了快照：{len(rows)}/{writers}"
    assert sorted(row["followers"] for row in rows) == sorted(now - i for i in range(writers))


def test_snapshot_writes_leave_no_half_written_file(analytics_dir):
    """写入必须先落临时文件再替换：中途崩溃留下半个 JSON 行会让整段历史静默读不出来。"""
    now = int(time.time())
    account_stats.record_snapshot("douyin", {"ts": now, "followers": 5, "likes": 1, "posts": 1}, "uid-atomic")

    assert account_stats.load_history("douyin", "uid-atomic")[0]["followers"] == 5
    leftovers = [p.name for p in analytics_dir.rglob("*.tmp")]
    assert leftovers == [], f"残留临时文件：{leftovers}"


def test_growth_windows_pick_baseline_by_timestamp_not_file_order():
    """基线必须按 ts 排序取，不能依赖文件行序。

    时钟回拨、旧版本写入或外部导入都会让行序乱掉。若直接取 history[-1]，
    四个窗口会一起返回「对最老那条」的同一个错值——数字看着正常，最难发现。
    """
    now = 1_800_000_000
    day = 86400
    shuffled = [
        {"ts": now - 10 * day, "followers": 1000, "likes": 10, "posts": 5},
        {"ts": now - 1 * day, "followers": 1500, "likes": 20, "posts": 6},
        {"ts": now - 30 * day, "followers": 800, "likes": 8, "posts": 4},
    ]
    current = {"ts": now, "followers": 2000, "likes": 30, "posts": 7}

    growth = account_stats.growth_windows(shuffled, current)

    assert growth["last"]["followers"] == 500      # 对 1 天前
    assert growth["day"]["followers"] == 500       # 对 1 天前
    assert growth["week"]["followers"] == 1000     # 对 10 天前
    assert growth["month"]["followers"] == 1200    # 对 30 天前
    assert growth["week"]["since_days"] == 10.0


def test_snapshot_rows_without_ts_do_not_break_the_write(analytics_dir):
    """缺 ts 的历史行必须被跳过，而不是让整次快照写入抛 KeyError。

    旧版本写出的文件或手工导入的数据可能没有 ts。采集侧一旦抛异常，
    这一天的基线就永久丢了——比少一行脏数据严重得多。
    """
    now = int(time.time())
    path = account_stats._history_path("douyin", "uid-no-ts")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"ts": now - 5 * 86400, "followers": 900})
        + "\n" + json.dumps({"followers": 950}) + "\n",
        encoding="utf-8")

    account_stats.record_snapshot(
        "douyin", {"ts": now, "followers": 2000, "likes": 1, "posts": 1}, "uid-no-ts")

    rows = account_stats.load_history("douyin", "uid-no-ts")
    assert rows, "缺 ts 的行不应导致整次写入被丢弃"
    assert all("ts" in row for row in rows), f"缺 ts 的行应被跳过：{rows}"
    assert rows[-1]["followers"] == 2000


def test_growth_windows_ignore_rows_that_cannot_be_compared():
    """无法比较的行（缺 ts / 非数字 ts）不能变成基线，也不能让函数崩。"""
    now = 1_800_000_000
    current = {"ts": now, "followers": 2000, "likes": 30, "posts": 7}

    assert account_stats.growth_windows([], current)["last"] is None
    assert account_stats.growth_windows([{"followers": 1}], current)["last"] is None
    assert account_stats.growth_windows([{"ts": "abc", "followers": 1}], current)["last"] is None


def test_should_record_compares_against_the_newest_row_not_the_last_line():
    """「上一条」必须按 ts 取，不能拿文件末行。

    行序乱掉时拿末行当上一条会两头错：与最新读数相同却重复攒行；
    或真实变化被判成「没变」而静默丢弃——后者会让基线永久少一天，且没有任何报错。
    """
    now = 1_800_000_000
    day = 86400
    shuffled = [
        {"ts": now - 10 * day, "followers": 1000, "likes": 10, "posts": 5},
        {"ts": now - 60, "followers": 1500, "likes": 20, "posts": 6},        # 真正最新（同日，避免触发跨天必记）
        {"ts": now - 30 * day, "followers": 800, "likes": 8, "posts": 4},    # 末行却最老
    ]

    # 与真正最新读数完全相同 → 不该重复记
    assert account_stats.should_record(
        shuffled, {"ts": now, "followers": 1500, "likes": 20, "posts": 6}) is False
    # 与末行相同、但与真正最新不同 → 这是真实变化，必须记
    assert account_stats.should_record(
        shuffled, {"ts": now, "followers": 800, "likes": 8, "posts": 4}) is True
    # 真实变化
    assert account_stats.should_record(
        shuffled, {"ts": now, "followers": 1600, "likes": 20, "posts": 6}) is True
    # 空历史：没有可比对象，必须记
    assert account_stats.should_record([], {"ts": now, "followers": 1}) is True
    # 整份历史都没有 ts（旧版本文件）：退化为按行序比较，指标相同→不记，指标变了→记。
    # 缺 ts 不影响比较指标值，此时沿用旧语义，避免退化成「永远记录」。
    assert account_stats.should_record([{"followers": 1}], {"ts": now, "followers": 1}) is False
    assert account_stats.should_record([{"followers": 1}], {"ts": now, "followers": 2}) is True


def test_day_window_tolerates_small_collection_time_drift():
    """每日采集的时间点每天会漂移几秒到几分钟，日窗口必须吸收这点抖动。

    边界用精确比较时，今天比昨天早 5 秒采集，「较昨日」就永远取不到基线：
    采集明明成功，对比却恒为 null，看起来像没数据——正是最容易被当成「假数据」的情形。
    """
    base = 1_800_000_000
    day = 86400
    history = [{"ts": base, "followers": 100, "likes": 1, "posts": 1}]

    for drift in (0, 5, 60, 1800, 3600):
        current = {"ts": base + day - drift, "followers": 150, "likes": 2, "posts": 1}
        growth = account_stats.growth_windows(history, current)
        assert growth["day"] is not None, f"提前 {drift} 秒采集时「较昨日」丢了基线"
        assert growth["day"]["followers"] == 50
        assert growth["day"]["since_days"] == 1.0


def test_window_grace_does_not_swallow_a_nearer_window():
    """容差只吸收抖动，不能把不该算进来的快照当成基线。

    2 天前的快照本就满足「不晚于 1 天前」，是合法日基线；
    容差不该让 7 天前的快照越界变成日基线，也不该把 8 天前错算成周基线以外的窗口。
    """
    base = 1_800_000_000
    day = 86400
    now = base + 8 * day
    history = [
        {"ts": now - 2 * day, "followers": 100, "likes": 1, "posts": 1},
        {"ts": now - 8 * day, "followers": 200, "likes": 1, "posts": 1},
    ]
    growth = account_stats.growth_windows(
        history, {"ts": now, "followers": 300, "likes": 1, "posts": 1})

    # 日基线取最近一条满足 ≤ now-1d 的（2 天前），且如实标注 since_days
    assert growth["day"]["followers"] == 200
    assert growth["day"]["since_days"] == 2.0
    # 周基线必须取 8 天前那条，不能被 2 天前顶替
    assert growth["week"]["followers"] == 100
    assert growth["week"]["since_days"] == 8.0
    # 月窗口：两条都不满足 30 天，必须是 None 而不是拿更近的凑数
    assert growth["month"] is None


def test_window_grace_stays_bounded():
    """容差有上下限：小窗口取 5%，大窗口封顶 1 天，避免吞掉更远的基线。"""
    assert account_stats._window_grace(86400) == 4320        # 5% = 4320s (1.2h)，高于下限
    assert account_stats._window_grace(3600) == 3600         # 5% = 180s 低于下限 → 取 1 小时
    assert account_stats._window_grace(7 * 86400) == 30240   # 5% ≈ 8.4h
    assert account_stats._window_grace(30 * 86400) == 86400  # 5% = 1.5d 触上限
    assert account_stats._window_grace(365 * 86400) == 86400 # 不得无限放大


def test_worker_retries_when_collect_reports_failure_without_raising(tmp_path):
    """collect 返回 False（瞬时网络失败、子进程退出码非零）必须与抛异常同等待遇。

    旧实现直接标 day=今天：一次网络抖动就烧掉整天，日/周基线断档且无任何报错；
    而抛异常的路径却会重试。这里断言 False 也计入当日尝试次数并允许重试，
    且 tick() 的返回值只数真正写入快照的那次。
    """
    attempts = []
    worker = analytics_snapshot.SnapshotService(
        tmp_path, platforms=["douyin"], logged_in=lambda pf: True,
        collect=lambda pf: attempts.append(pf) or False,   # 采集"完成"但什么都没写入
        interval=0, initial_delay=0)

    assert worker.tick() == 0, "未写入快照不应被计成成功"
    assert worker.tick() == 0
    # 继续跑到当日尝试上限：之后当天不再重试，但每次都真实发起过采集。
    for _ in range(analytics_snapshot.MAX_ATTEMPTS_PER_DAY):
        worker.tick()
    assert len(attempts) == analytics_snapshot.MAX_ATTEMPTS_PER_DAY
    entry = worker.status()["platforms"]["douyin"]
    assert entry["day"] is None, "未写入就不该把今天标记为已完成"
    assert "未能写入快照" in entry["error"]


def test_worker_marks_day_done_only_after_a_recorded_snapshot(tmp_path):
    """先失败几次、随后真正写入：应当标记当天完成并把尝试次数清零。"""
    results = [False, False, True]
    attempts = []
    worker = analytics_snapshot.SnapshotService(
        tmp_path, platforms=["douyin"], logged_in=lambda pf: True,
        collect=lambda pf: attempts.append(pf) or results.pop(0),
        interval=0, initial_delay=0)

    assert worker.tick() == 0
    assert worker.tick() == 0
    assert worker.tick() == 1
    assert worker.tick() == 0, "当天已写入，不应重复采集"
    entry = worker.status()["platforms"]["douyin"]
    assert entry["day"] is not None and entry["error"] == "" and entry["attempts"] == 0
