#!/usr/bin/env python3
"""xhs_publish.py — 小红书发布（Playwright，headless 可用）.

替代旧的 CDP-to-真实Chrome 死栈（那套需桌面 Chrome，本 Linux 环境跑不了）。
本脚本用 Playwright + 持久化登录态，headless 即可发布，流程与选择器移植自
xpzouying/xiaohongshu-mcp（Go/go-rod，成熟稳定）。确定性 IO 固化在脚本，
文案/策略仍由上层 LLM 决定。

移植的关键健壮技巧（源见各处 REF 注释）：
  - 切「上传图文/视频」tab：重试 + 遮挡检测 + 移除弹层
  - 逐图上传并等预览出现（≤60s）；视频等发布按钮可点击（≤10min = 处理完成）
  - 话题：输 # + 联想下拉点选，真绑话题
  - 发布按钮：新版 <xhs-publish-btn> + 旧版 .bg-red 双兼容
  - 提交校验：发前快照 + 本人作品读回，分别确认作品身份、审核状态与公开权限
  - 反检测：--disable-blink-features=AutomationControlled + 逐字符输入 + zh-CN

子命令:
  check          验 playwright + chromium 内核
  login          有头扫码登录并持久化 cookie
  plan           离线打印发布步骤与选择器（不启浏览器）
  publish        图文发布（--images 逗号分隔）
  publish-video  视频发布（--video）
  verify-publish 只读核实已提交笔记（--title、--since-ms，可选 --content-id）
  selftest       离线自检（选择器字典 / 参数解析 / 标题长度算法）

真实发布需：playwright + chromium 内核 + 已扫码登录 + 外网可达（默认走项目代理）。
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import login_state  # noqa: E402
import login_qr  # noqa: E402
import login_transport  # noqa: E402
import content_guard  # noqa: E402  出站内容安全闸门
import publish_receipt  # noqa: E402
import xhs_readback  # noqa: E402

# --------------------------------------------------------------------------- #
# 选择器集中维护（小红书改版时单点更新）。REF = xiaohongshu-mcp 对应源。
# --------------------------------------------------------------------------- #
PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?source=official"
EXPLORE_URL = "https://www.xiaohongshu.com/explore"
CREATOR_LOGIN_URL = "https://creator.xiaohongshu.com/login"
CREATOR_HOME_URL = "https://creator.xiaohongshu.com/new/home"
CREATOR_ACCOUNT_URL = "https://creator.xiaohongshu.com/api/galaxy/user/info"
TITLE_MAX = 20  # 小红书标题上限（全角计法，见 calc_title_length）

SELECTORS = {
    # 登录（REF login.go）
    "login_ok": ".main-container .user .link-wrapper .channel",
    "qrcode": ".login-container .qrcode-img, .qrcode-img, [class*='qrcode' i] img, "
              "[class*='qrcode' i] canvas, [class*='qr-code' i], img[src*='qrcode' i], "
              ".sso-login-wrapper img, .sso-login-wrapper canvas, "
              ".login-container img[alt*='二维码']",
    "logged_out": ".login-container, .login-modal, .login-box, "
                  ".sso-login-wrapper, .qrcode-img, [class*='qrcode' i], [class*='qr-code' i]",
    "login_entry": ".side-bar-component.login-btn, button.login-btn",
    "qr_switch": "button:has-text('扫码登录'), [role='tab']:has-text('扫码登录'), "
                 ".login-type:has-text('扫码登录'), .sso-login-wrapper > div > div > img",
    # 进页/切 tab（REF publish.go mustClickPublishTab）
    "upload_content": "div.upload-content",
    "creator_tab": "div.creator-tab",
    "pop_cover": "div.d-popover",
    # 上传（REF publish.go uploadImages / publish_video.go uploadVideo）
    "upload_input_first": ".upload-input",
    "upload_input_more": "input[type=file]",
    "img_preview": ".img-preview-area .pr",
    # 标题/正文（REF publish.go submitPublish / getContentElement）
    "title_input": "div.d-input input, input[placeholder*='标题']",
    "content_quill": "div.ql-editor",
    "content_editable": "div.editor-container [contenteditable='true'], [contenteditable='true']",
    "content_placeholder": "p[data-placeholder*='输入正文描述']",
    "title_overflow": "div.title-container div.max_suffix",
    "content_overflow": "div.edit-container div.length-error",
    # 话题（REF publish.go inputTag）
    "topic_container": "#creator-editor-topic-container",
    "topic_item": "#creator-editor-topic-container .item",
    # 发布按钮（REF publish.go findPublishButton）
    "publish_btn_new": "xhs-publish-btn",
    "publish_btn_old": ".publish-page-publish-btn button.bg-red",
}

PROFILE_NAME = "XiaohongshuProfile"
PROJECT_ROOT = Path(os.environ.get("EASEL_DATA_DIR") or os.environ.get("EASEL_ROOT") or Path(__file__).resolve().parents[3])
DEFAULT_QR_OUT = PROJECT_ROOT / "outputs" / "_login" / "xhs-login-qrcode.png"

# Chromium 启动性能参数（提速冷启动；勿禁用图片——二维码是图片）
LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--disable-extensions", "--disable-background-networking",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-features=TranslateUI,BackForwardCache",
    "--mute-audio", "--no-first-run", "--no-default-browser-check",
]


# --------------------------------------------------------------------------- #
# 纯函数（可离线自测）
# --------------------------------------------------------------------------- #
def calc_title_length(s: str) -> int:
    """小红书标题长度：UTF-16 码元非 ASCII 计 2、ASCII 计 1，再 (n+1)//2 上取整。
    REF pkg/xhsutil/title.go CalcTitleLength。20 全角字 → 20。"""
    utf16 = s.encode("utf-16-le")
    byte_len = 0
    for i in range(0, len(utf16), 2):
        code = utf16[i] | (utf16[i + 1] << 8)
        byte_len += 2 if code > 127 else 1
    return (byte_len + 1) // 2


def _die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def _abspaths(csv: str | None) -> list[str]:
    """逗号分隔路径 → 绝对路径列表，校验存在。"""
    if not csv:
        return []
    out = []
    for raw in csv.split(","):
        raw = raw.strip()
        if not raw:
            continue
        p = Path(raw).expanduser().resolve()
        if not p.is_file():
            _die(f"文件不存在：{p}")
        out.append(str(p))
    return out


def _profile_dir(base: str | None) -> Path:
    root = Path(base).expanduser() if base else Path.home() / ".easel-browser-profiles"
    return root / PROFILE_NAME


def _cloak_executable() -> Path | None:
    """本机已装的 CloakBrowser 内核。只用 ~/.cloakbrowser，不用调研 profile / 9344 / 9345。

    无头 Playwright Chromium 会被小红书 300012；同一出口下 Cloak 无头已实测能出码。
    """
    override = (os.environ.get("EASEL_CLOAK_BROWSER") or "").strip()
    if override:
        p = Path(override).expanduser()
        return p if p.is_file() else None
    root = Path.home() / ".cloakbrowser"
    if not root.is_dir():
        return None
    choices = sorted(root.glob("chromium-*/chrome.exe"), key=lambda p: p.stat().st_mtime, reverse=True)
    return choices[0] if choices else None


class _ProfileLock:
    """同一份 XiaohongshuProfile 不能同时开两个 Cloak：账号页 whoami 和登录会把内核打成 exit 21。"""

    def __init__(self, profile: Path):
        self.path = profile / ".easel.lock"
        self.fd: int | None = None

    def acquire(self, timeout_s: float) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.time() + timeout_s
        last: OSError | None = None
        while True:
            try:
                self.fd = os.open(str(self.path), os.O_CREAT | os.O_RDWR)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                os.lseek(self.fd, 0, os.SEEK_SET)
                os.write(self.fd, f"{os.getpid()}\n".encode("ascii"))
                return
            except OSError as e:
                last = e
                if self.fd is not None:
                    try:
                        os.close(self.fd)
                    except OSError:
                        pass
                    self.fd = None
                if time.time() >= deadline:
                    raise TimeoutError(f"登录目录正被占用：{self.path}") from last
                time.sleep(0.4)

    def release(self) -> None:
        if self.fd is None:
            return
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass
        self.fd = None


def _clear_stale_chrome_locks(profile: Path) -> None:
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        p = profile / name
        try:
            p.unlink()
        except OSError:
            pass


def _browser_channel() -> str | None:
    """Cloak 找不到时，有头登录才退回本机 Chrome/Edge。"""
    if os.name != "nt":
        return None
    pf = Path(os.environ.get("PROGRAMFILES", r"C:\Program Files"))
    pf86 = Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"))
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    chrome = (
        pf / "Google" / "Chrome" / "Application" / "chrome.exe",
        pf86 / "Google" / "Chrome" / "Application" / "chrome.exe",
        local / "Google" / "Chrome" / "Application" / "chrome.exe",
    )
    if any(p.is_file() for p in chrome):
        return "chrome"
    edge = (
        pf / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        pf86 / "Microsoft" / "Edge" / "Application" / "msedge.exe",
    )
    if any(p.is_file() for p in edge):
        return "msedge"
    return None


def _login_error(page) -> str:
    """区分明确 IP 风险和其它错误页，不泄露 URL 中的登录参数。"""
    try:
        url = page.url or ""
        title = page.title() or ""
        try:
            text = page.inner_text("body", timeout=2000)[:3000]
        except Exception:
            text = ""
        if any(message in title + text for message in (
                "工程师正在", "工程师在紧急", "系统维护中", "系统正在维护", "页面维护中")):
            return ("小红书当前入口显示维护页面，暂时无法完成登录校验。"
                    "这不是二维码过期或账号退出，请稍后重试。")
        codes = parse_qs(urlparse(url).query).get("error_code", [])
        code = codes[0] if codes and codes[0].isdigit() and len(codes[0]) <= 32 else ""
        error_page = "website-login/error" in url or "安全限制" in title or bool(code)
        if not error_page:
            return ""
        if code == "300012" or "IP存在风险" in re.sub(r"\s+", "", text).upper():
            detail = f"（错误码 {code}）" if code else ""
            return (f"小红书返回 IP 风险限制{detail}，二维码无法获取。"
                    "请在可信网络重试；服务器/机房出口可能被平台限制，Easel 无法保证解除风控。")
        detail = f"（错误码 {code}）" if code else ""
        return f"小红书登录被平台拦截{detail}，不一定是 IP 问题。请检查网络，或使用 --headed 查看平台提示。"
    except Exception:
        return ""


def _risk_blocked(page) -> bool:
    return "IP 风险限制" in _login_error(page)


def _visible_login_element(page, selectors: str):
    for selector in selectors.split(","):
        for element in page.query_selector_all(selector.strip()):
            if element.is_visible():
                return element
    return None


def _open_login_dialog(page) -> None:
    creator = urlparse(page.url or "").hostname == "creator.xiaohongshu.com"
    if not _visible_login_element(page, SELECTORS["logged_out"]):
        try:
            page.wait_for_selector(
                f"{SELECTORS['logged_out']}, {SELECTORS['login_entry']}, {SELECTORS['login_ok']}",
                state="visible", timeout=45000 if creator else 15000)
        except Exception:
            pass
    if creator:
        try:
            page.wait_for_selector(".sso-login-wrapper", state="visible", timeout=15000)
            page.wait_for_selector(".sso-login-wrapper [data-testid='loading']",
                                   state="hidden", timeout=15000)
        except Exception:
            pass
    if _visible_login_element(page, SELECTORS["logged_out"]):
        return
    if urlparse(page.url or "").hostname == "www.xiaohongshu.com":
        button = _visible_login_element(page, SELECTORS["login_entry"])
        if button:
            button.click(timeout=3000, no_wait_after=True)


def _missing_qr_reason(page) -> str:
    try:
        text = page.inner_text("body", timeout=2000).strip()
    except Exception:
        return "登录页面尚未就绪，请检查网络连接后重试"
    if not text:
        return "登录页面空白，平台脚本未完成加载，请检查网络连接后重试"
    if "扫一扫" in text or "扫码登录" in text:
        return "已切换扫码登录，但二维码未加载或无法识别，请稍后重试"
    if "短信登录" in text or "发送验证码" in text:
        return "页面仍停留在短信登录，扫码切换控件未就绪或失效；可用 --headed 查看平台提示"
    return "未找到可识别的登录二维码，登录弹窗未打开或页面结构已变化"


def _capture_login_qr(page, qr_out: Path, *, creator_only: bool = False) -> bool:
    """首页无法出码时只尝试一次官方创作平台入口；False 表示已登录。"""
    failures = []
    for url in ((CREATOR_LOGIN_URL,) if creator_only else (None, CREATOR_LOGIN_URL)):
        entry = "创作平台" if url else "小红书首页"
        try:
            if url:
                page.goto(url, wait_until="commit", timeout=30000)
        except Exception as error:
            reason = f"打不开小红书创作平台（{type(error).__name__}），请检查网络连接后重试"
            failures.append(f"{entry}：{reason}")
            continue
        if _is_logged_in(page):
            return False
        reason = _login_error(page)
        if not reason:
            try:
                _open_login_dialog(page)
                reason = _login_error(page)
                if reason:
                    failures.append(f"{entry}：{reason}")
                    continue
                login_qr.prepare_qr(page, qr_out, SELECTORS["qrcode"],
                                    SELECTORS["qr_switch"], minimum_size=96)
                return True
            except Exception as error:
                if _is_logged_in(page):
                    return False
                reason = _login_error(page) or _missing_qr_reason(page)
                print(f"小红书抓码失败（{entry}/{type(error).__name__}）：{reason}", file=sys.stderr)
        failures.append(f"{entry}：{reason}")
    raise RuntimeError("；".join(failures))


def _is_logged_in(page) -> bool:
    try:
        location = urlsplit(page.url)
        if (location.scheme != 'https' or location.hostname not in
                ('www.xiaohongshu.com', 'xiaohongshu.com', 'creator.xiaohongshu.com')
                or location.username is not None or location.password is not None):
            return False
    except (ValueError, AttributeError):
        return False
    if _login_error(page):
        return False
    try:
        for element in page.query_selector_all(SELECTORS["logged_out"]):
            if element.is_visible():
                return False
    except Exception:
        pass
    try:
        for element in page.query_selector_all(SELECTORS["login_ok"]):
            if element.is_visible():
                return True
    except Exception:
        pass
    try:
        url = urlparse(page.url or "")
        if (url.hostname == "creator.xiaohongshu.com"
                and not parse_qs(url.query).get("error_code")
                and (url.path.startswith(("/publish/", "/new/", "/home/")) or url.path == "/home")):
            for account in page.query_selector_all(".user-info"):
                if not account.is_visible():
                    continue
                avatar = account.query_selector("img.user_avatar")
                name = account.query_selector("span")
                if (avatar and avatar.is_visible() and avatar.get_attribute("src")
                        and name and name.is_visible() and name.inner_text().strip()):
                    return True
    except Exception:
        pass
    return False


def _qr_state(page) -> str:
    try:
        text = page.inner_text(
            ".sso-login-wrapper, .login-container, .login-modal, .login-box",
            timeout=1000)
    except Exception:
        return ""
    compact = re.sub(r"\s+", "", text)
    if any(message in compact for message in (
            "扫码成功", "扫描成功", "已扫码", "请在手机上确认", "请在APP上确认")):
        return "scanned"
    if any(message in compact for message in (
            "二维码已失效", "二维码失效", "二维码已过期", "二维码过期", "二维码无效")):
        return "expired"
    return ""


def _refresh_expired_qr(page, qr_out: Path) -> bool:
    if _qr_state(page) != "expired":
        return False
    selectors = (
        ".sso-login-wrapper button:has-text('刷新'), "
        ".sso-login-wrapper [role='button']:has-text('刷新'), "
        ".sso-login-wrapper a:text-is('点击刷新'), "
        ".sso-login-wrapper span:text-is('点击刷新'), "
        ".sso-login-wrapper div:text-is('点击刷新'), "
        ".login-container button:has-text('刷新'), "
        ".login-container span:text-is('刷新二维码'), "
        ".login-container div:text-is('刷新二维码'), "
        ".login-container a:text-is('点击刷新'), "
        ".login-container span:text-is('点击刷新'), "
        ".login-container div:text-is('点击刷新')"
    )
    button = _visible_login_element(page, selectors)
    if button is None:
        return False
    button.click(timeout=3000)
    page.wait_for_timeout(800)
    if _qr_state(page) == "scanned":
        return False
    login_qr.capture_qr(page, qr_out, SELECTORS["qrcode"], minimum_size=96)
    return True


def _verify_login(page, timeout_s: float = 6) -> bool:
    deadline = time.monotonic() + timeout_s
    confirmed = 0
    while time.monotonic() < deadline:
        if _is_logged_in(page):
            confirmed += 1
            if confirmed >= 2:
                return True
        else:
            confirmed = 0
        if _login_error(page) or _visible_login_element(page, SELECTORS["logged_out"]):
            return False
        page.wait_for_timeout(500)
    return False


def _check_account_login(page) -> bool:
    outcomes = []
    deadline = time.monotonic() + 14
    for destination in (CREATOR_HOME_URL, EXPLORE_URL):
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                outcomes.append("unknown")
                break
            page.goto(destination, wait_until="commit", timeout=min(4000, remaining * 1000))
            remaining = deadline - time.monotonic()
            if remaining > 0 and _verify_login(page, timeout_s=min(4, remaining)):
                return True
            outcomes.append("unknown" if _login_error(page) or not _visible_login_element(
                page, SELECTORS["logged_out"]) else "logged_out")
        except Exception:
            outcomes.append("unknown")
    if any(outcome != "logged_out" for outcome in outcomes):
        raise RuntimeError("小红书登录校验暂未完成：网络超时、维护/风控页面或账号界面未就绪；保留上次登录状态")
    return False


def _creator_account(context) -> dict | None:
    try:
        response = context.request.get(
            CREATOR_ACCOUNT_URL, headers={"Referer": CREATOR_HOME_URL}, timeout=5000)
        if response.status != 200:
            return None
        payload = response.json()
        account = payload.get("data")
        if (payload.get("success") is True and isinstance(account, dict)
                and isinstance(account.get("userId"), str) and account["userId"].strip()):
            return account
    except Exception:
        pass
    return None


def _web_account(context) -> dict | None:
    try:
        response = context.request.get(EXPLORE_URL, timeout=4000)
        if response.status != 200:
            return None
        return _web_account_html(response.text())
    except Exception:
        return None


def _initial_state(html: str) -> dict:
    if len(html) > 2_000_000:
        return {}
    match = re.search(
        r"<script\b[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)</script>",
        html, re.IGNORECASE)
    if not match:
        return {}
    serialized = re.sub(
        r'"(?:\\.|[^"\\])*"|\bundefined\b',
        lambda token: "null" if token.group() == "undefined" else token.group(),
        match.group(1).strip().rstrip(";"))
    try:
        state = json.loads(serialized)
        return state if isinstance(state, dict) else {}
    except ValueError:
        return {}


def _unwrap_state(value):
    if isinstance(value, dict) and "userId" not in value and "basicInfo" not in value:
        if "value" in value:
            return value["value"]
        if "_value" in value:
            return value["_value"]
    return value


def _state_account(state: dict) -> dict | None:
    user = state.get("user")
    account = _unwrap_state(user.get("userInfo")) if isinstance(user, dict) else None
    if (not isinstance(account, dict) or _unwrap_state(user.get("loggedIn")) is not True
            or not isinstance(account.get("userId"), str)
            or not re.fullmatch(r"[A-Za-z0-9_-]+", account["userId"])):
        return None
    identity = _account_identity(account)
    return {**account, "userName": identity["name"], "userAvatar": identity["avatar"]}


def _web_account_html(html: str) -> dict | None:
    return _state_account(_initial_state(html))


def _self_profile_identity(state: dict, user_id: str) -> dict:
    identity = {"name": "", "avatar": ""}
    account = _state_account(state)
    if account is None or account["userId"] != user_id:
        return identity
    profile = _unwrap_state(state["user"].get("userPageData"))
    if not isinstance(profile, dict) or profile.get("userId", user_id) != user_id:
        return identity
    basic = profile.get("basicInfo")
    return _account_identity(basic) if isinstance(basic, dict) else identity


def _self_profile_account(context, account: dict) -> dict:
    user_id = account.get("userId")
    if not isinstance(user_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", user_id):
        return account
    destination = f"https://www.xiaohongshu.com/user/profile/{user_id}"
    try:
        response = context.request.get(
            destination, headers={"Referer": EXPLORE_URL}, timeout=4000)
        current_url = urlparse(response.url)
        if (response.status != 200 or current_url.hostname != "www.xiaohongshu.com"
                or current_url.path.rstrip("/") != urlparse(destination).path):
            return account
        fallback = _self_profile_identity(_initial_state(response.text()), user_id)
        identity = _account_identity(account)
        return {**account, "userName": fallback["name"] or identity["name"],
                "userAvatar": fallback["avatar"] or identity["avatar"]}
    except Exception:
        return account


def _authenticated_account(context) -> dict | None:
    account = _web_account(context)
    if account is not None and all(_account_identity(account).values()):
        return account
    creator = _creator_account(context)
    if account is None:
        return creator
    if creator is None or creator.get("userId") != account.get("userId"):
        return account
    identity = _account_identity(account)
    fallback = _account_identity(creator)
    return {
        **account,
        "userName": identity["name"] or fallback["name"],
        "userAvatar": identity["avatar"] or fallback["avatar"],
    }


def _account_identity(account: dict) -> dict:
    name = next((account[key].strip()[:40] for key in ("userName", "nickname", "user_name", "name")
                 if isinstance(account.get(key), str) and account[key].strip()), "")
    avatar = ""
    for key in ("userAvatar", "imageb", "images", "avatar", "user_avatar"):
        candidate = account.get(key)
        if not isinstance(candidate, str):
            continue
        candidate = candidate.strip()
        if candidate.startswith("//"):
            candidate = "https:" + candidate
        try:
            parsed = urlparse(candidate)
            if (parsed.scheme in ("https", "http") and parsed.hostname
                    and not parsed.username and not parsed.password
                    and not any(ord(character) < 32 for character in candidate)):
                avatar = candidate
                break
        except ValueError:
            continue
    return {"name": name, "avatar": avatar}


def _page_account_identity(page, user_id: str | None = None) -> dict:
    identity = {"name": "", "avatar": ""}
    if urlparse(page.url or "").hostname == "creator.xiaohongshu.com":
        for account in page.query_selector_all(".user-info"):
            if not account.is_visible():
                continue
            avatar = account.query_selector("img.user_avatar")
            name = account.query_selector("span")
            if avatar and avatar.is_visible() and name and name.is_visible():
                return _account_identity({
                    "userName": name.inner_text(),
                    "userAvatar": avatar.get_attribute("src"),
                })
        return identity
    profile_url = (f"https://www.xiaohongshu.com/user/profile/{user_id}"
                   if isinstance(user_id, str) and re.fullmatch(r"[A-Za-z0-9_-]+", user_id) else "")
    for channel in ([] if profile_url else page.query_selector_all(SELECTORS["login_ok"])):
        if not channel.is_visible():
            continue
        account = channel.evaluate("""element => {
            const anchor = element.closest('a[href]') || element.querySelector('a[href]')
                || element.closest('.user')?.querySelector('a[href*="/user/profile/"]');
            return {
                href: anchor?.getAttribute('href') || '',
                avatar: anchor?.querySelector('img')?.getAttribute('src') || ''
            };
        }""")
        if not isinstance(account, dict):
            continue
        href = account.get("href")
        if not isinstance(href, str):
            continue
        candidate = urlparse(href)
        if (candidate.scheme or candidate.netloc
                or not re.fullmatch(r"/user/profile/[A-Za-z0-9_-]+/?", candidate.path)):
            continue
        profile_url = "https://www.xiaohongshu.com" + candidate.path
        identity["avatar"] = _account_identity({"userAvatar": account.get("avatar")})["avatar"]
        break
    if not profile_url:
        return identity
    try:
        page.goto(profile_url, wait_until="commit", timeout=4000)
        current_url = urlparse(page.url or "")
        if (current_url.hostname != "www.xiaohongshu.com"
                or current_url.path.rstrip("/") != urlparse(profile_url).path.rstrip("/")):
            return identity
        try:
            page.wait_for_function(
                """() => {
                    const profile = window.__INITIAL_STATE__?.user?.userPageData;
                    return !!(profile?.basicInfo || profile?.value?.basicInfo || profile?._value?.basicInfo);
                }""",
                timeout=1500)
        except Exception:
            pass
        try:
            state = page.evaluate("""() => {
                const user = window.__INITIAL_STATE__?.user;
                return user ? JSON.parse(JSON.stringify({user: {
                    loggedIn: user.loggedIn, userInfo: user.userInfo, userPageData: user.userPageData
                }})) : {};
            }""")
            if isinstance(state, dict):
                own_account = _state_account(state)
                if own_account is not None and own_account["userId"] != urlparse(profile_url).path.rstrip("/").split("/")[-1]:
                    return {"name": "", "avatar": ""}
                extracted = _self_profile_identity(state, urlparse(profile_url).path.rstrip("/").split("/")[-1])
                if all(extracted.values()):
                    return extracted
                identity.update({key: value for key, value in extracted.items() if value})
        except Exception:
            pass
        selectors = ".user-profile .user-info, .user-page .user-info, .user .user-info, .user-profile .info-part"
        page.wait_for_selector(selectors, state="visible", timeout=3000)
        for account in page.query_selector_all(selectors):
            if not account.is_visible():
                continue
            name = account.query_selector(".user-name, .username, .name")
            avatar = account.query_selector("img.avatar, img.user-avatar, img.avatar-item, .avatar img")
            if name and name.is_visible():
                text = name.inner_text().strip()
                if text:
                    identity["name"] = text.splitlines()[0][:40]
            if avatar and avatar.is_visible():
                identity["avatar"] = _account_identity({"userAvatar": avatar.get_attribute("src")})["avatar"]
            if identity["name"]:
                break
    except Exception:
        pass
    return identity


def _proxy(explicit: str | None, disable: bool) -> str | None:
    """外网代理：--no-proxy 关；--proxy 显式；否则取 env（小红书是外网，默认需代理）。"""
    if disable:
        return None
    if explicit:
        return explicit
    return os.environ.get("https_proxy") or os.environ.get("http_proxy") \
        or os.environ.get("EASEL_PROXY")


# --------------------------------------------------------------------------- #
# 浏览器动作（移植自 xiaohongshu-mcp，需 playwright）
# --------------------------------------------------------------------------- #
def _human_type(page, locator, text: str) -> None:
    """逐字符输入 + 随机间隔（反检测，REF humanize/input.go Type）。"""
    locator.click()
    for ch in text:
        page.keyboard.type(ch)
        page.wait_for_timeout(random.randint(30, 110))


def _click_publish_tab(page, tabname: str) -> None:
    """点「上传图文/上传视频」tab：重试 15s + 遮挡检测 + 移弹层。REF mustClickPublishTab。"""
    page.wait_for_selector(SELECTORS["upload_content"], timeout=15000)
    deadline = time.time() + 15
    while time.time() < deadline:
        tabs = page.query_selector_all(SELECTORS["creator_tab"])
        for tab in tabs:
            try:
                if not tab.is_visible():
                    continue
                if (tab.inner_text() or "").strip() != tabname:
                    continue
            except Exception:
                continue
            # 遮挡检测（REF isElementBlocked：elementFromPoint 命中的是不是自己）
            blocked = tab.evaluate(
                """(el) => { const r = el.getBoundingClientRect();
                    if (!r.width || !r.height) return true;
                    const t = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
                    return !(t === el || el.contains(t)); }""")
            if blocked:
                cover = page.query_selector(SELECTORS["pop_cover"])
                if cover:
                    cover.evaluate("el => el.remove()")
                page.wait_for_timeout(200)
                continue
            tab.click()
            return
        page.wait_for_timeout(200)
    _die(f"未找到发布 TAB：{tabname}（页面结构可能已变，检查 SELECTORS.creator_tab）")


def _upload_images(page, paths: list[str]) -> None:
    """逐张上传并等预览出现（≤60s/张）。REF uploadImages/waitForUploadComplete。"""
    for i, path in enumerate(paths):
        sel = SELECTORS["upload_input_first"] if i == 0 else SELECTORS["upload_input_more"]
        page.set_input_files(sel, path)
        print(f"  上传图片 {i+1}/{len(paths)}: {path}", file=sys.stderr)
        deadline = time.time() + 60
        while time.time() < deadline:
            if len(page.query_selector_all(SELECTORS["img_preview"])) >= i + 1:
                break
            page.wait_for_timeout(500)
        else:
            _die(f"第 {i+1} 张图片上传超时（60s）")
        page.wait_for_timeout(1000)


def _upload_video(page, path: str) -> None:
    """上传视频，等发布按钮可点击（≤10min = 处理完成）。REF publish_video.go uploadVideo。"""
    sel = SELECTORS["upload_input_first"]
    if not page.query_selector(sel):
        sel = SELECTORS["upload_input_more"]
    page.set_input_files(sel, path)
    print(f"  上传视频：{path}（等待处理，最长 10min）", file=sys.stderr)
    _wait_publish_clickable(page, timeout_s=600)


def _content_element(page):
    """正文输入框：先 ql-editor（旧版），再 contenteditable（新版），最后退回 placeholder 定位。
    REF getContentElement。小红书已把正文编辑器从 Quill 换成 contenteditable。"""
    el = page.query_selector(SELECTORS["content_quill"])
    if el:
        return el
    el = page.query_selector(SELECTORS["content_editable"])
    if el:
        return el
    ph = page.query_selector(SELECTORS["content_placeholder"])
    if ph:
        cur = ph
        for _ in range(5):
            parent = cur.evaluate_handle("el => el.parentElement").as_element()
            if not parent:
                break
            role = parent.get_attribute("role") or ""
            if role == "textbox" or parent.get_attribute("contenteditable") == "true":
                return parent
            cur = parent
    return None


def _check_overflow(page) -> None:
    """标题/正文超限：读平台自身的溢出提示元素。REF checkTitleMaxLength/checkContentMaxLength。"""
    for key, name in (("title_overflow", "标题"), ("content_overflow", "正文")):
        el = page.query_selector(SELECTORS[key])
        if el and el.is_visible():
            _die(f"{name}超出平台长度限制：{(el.inner_text() or '').strip()}")


def _input_tags(page, content_el, tags: list[str]) -> None:
    """话题：正文末尾输 # + 联想下拉点第一项，真绑话题。REF inputTag。

    注意：必须把 # 与话题名**连续输入**、中途不能再 click 正文——否则光标会被挪走，
    # 和话题名被拆开，小红书识别不到连续的 #话题 token，联想不出、绑不上话题。
    """
    if not tags:
        return
    content_el.click()
    page.keyboard.press("Control+End")   # 光标移到正文末尾，避免 # 插到正文中间
    page.wait_for_timeout(400)
    for tag in tags:
        tag = tag.lstrip("#").strip()
        if not tag:
            continue
        page.keyboard.type(" ")          # 与正文/上一话题分隔，确保 # 起一个新 token
        page.keyboard.type("#")
        page.wait_for_timeout(300)
        for ch in tag:                   # 逐字输入话题名——不再 click（避免移光标拆开 #话题）
            page.keyboard.type(ch)
            page.wait_for_timeout(random.randint(30, 110))
        page.wait_for_timeout(1000)
        item = page.query_selector(SELECTORS["topic_item"])
        if item:
            item.click()                 # 点联想第一项 = 真正绑定话题
        else:
            page.keyboard.type(" ")      # 无联想则退化为空格分隔（至少保留 #文字）
        page.wait_for_timeout(500)


def _wait_publish_clickable(page, timeout_s: int = 15):
    """等发布按钮可点击（新旧兼容）。REF findPublishButton/waitForPublishButtonClickable。"""
    deadline = time.time() + timeout_s
    last = ""
    while time.time() < deadline:
        for w in page.query_selector_all(SELECTORS["publish_btn_new"]):
            if not w.is_visible():
                continue
            if (w.get_attribute("is-publish") or "") == "false":
                continue
            if (w.get_attribute("submit-disabled") or "") == "true":
                last = "新版发布按钮不可点击"
                continue
            return ("new", w)
        for b in page.query_selector_all(SELECTORS["publish_btn_old"]):
            if not b.is_visible():
                continue
            if b.get_attribute("disabled") is not None:
                last = "旧版发布按钮 disabled"
                continue
            if (b.get_attribute("aria-disabled") or "") == "true":
                last = "旧版发布按钮 aria-disabled"
                continue
            return ("old", b)
        page.wait_for_timeout(1000)
    _die(f"等待发布按钮可点击超时{('：' + last) if last else ''}")


def _diag_after_publish(page) -> str:
    """点发布后失败时，抓屏幕上可见的弹框/报错/toast 文案，供排错。
    截图默认不存（正常使用不截图）；排错时设 EASEL_PUBLISH_DEBUG=1 才会存失败截图。"""
    bits = []
    for sel in (".d-modal", "[role=dialog]", "[class*=modal]", "[class*=dialog]",
                ".d-message", ".d-toast", "[class*=toast]", "[class*=error]", "[class*=tip]"):
        try:
            for el in page.query_selector_all(sel):
                if el.is_visible():
                    t = (el.inner_text() or "").strip().replace("\n", " / ")
                    if t and t not in " ".join(bits):
                        bits.append(f"[{sel}] {t[:120]}")
        except Exception:
            pass
    shot = ""
    if os.environ.get("EASEL_PUBLISH_DEBUG"):
        try:
            out = PROJECT_ROOT / "outputs" / "_login" / "xhs-publish-fail.png"
            out.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(out))
            shot = f"（调试截图见 {out}）"
        except Exception:
            pass
    return ("屏幕可见元素：" + " | ".join(bits[:6]) if bits else "屏幕无可识别弹框/报错") + shot


def _confirm_publish_dialog(page) -> None:
    """点发布后若弹二次确认框，点其确认按钮（保守：仅当可见且文案匹配）。"""
    deadline = time.time() + 5
    while time.time() < deadline:
        for b in page.query_selector_all("button, .d-button, [role=button]"):
            try:
                if not b.is_visible():
                    continue
                tx = (b.inner_text() or "").strip()
                if tx in ("确认发布", "确定发布", "继续发布", "立即发布", "确认", "确定"):
                    b.click()
                    page.wait_for_timeout(1000)
                    return
            except Exception:
                pass
        page.wait_for_timeout(500)


def _wait_publish_success(page, timeout_s: int = 40) -> str:
    """Check submission UI only; these signals never prove public publication."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        parsed = urlsplit(page.url or "")
        if (parsed.scheme != "https" or parsed.hostname != "creator.xiaohongshu.com"
                or "login" in parsed.path.lower()):
            _die("提交后页面离开创作者站点或进入登录页，发布结果未核实。", 5)
        for sel in (".d-message", ".d-toast", "[class*=toast]", "[class*=message]"):
            try:
                el = page.query_selector(sel)
                text = (el.inner_text() or "") if el and el.is_visible() else ""
                if (any(word in text for word in ("发布成功", "提交成功"))
                        and not any(word in text for word in ("未发布成功", "未提交成功", "失败"))):
                    print("ℹ️ 检测到提交提示，公开发布状态尚未读回核实。")
                    return "success_message"
            except Exception:
                pass
        if parsed.path.rstrip("/") != "/publish/publish":
            print("ℹ️ 提交后编辑页已跳转，平台结果仍需核实。")
            return "page_navigation"
        # 仅在原编辑页检查复位；登录页/错误页的空表单不能充当提交证据。
        try:
            if (not page.query_selector(SELECTORS["title_input"])
                    and not page.query_selector(SELECTORS["img_preview"])):
                print("ℹ️ 编辑表单已复位，公开发布状态尚未读回核实。")
                return "form_reset"
        except Exception:
            pass
        page.wait_for_timeout(500)
    _die("发布未确认成功：点击发布后未跳离发布页/未见成功提示。" + _diag_after_publish(page))


def _normalize_content(text: str) -> str:
    """小红书编辑器「不支持连续空行输入」——把 2+ 连续空行压成单个空行，行尾空白清掉。"""
    if not text:
        return text
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)      # 行尾空白
    text = re.sub(r"\n{3,}", "\n\n", text)       # 连续空行（3+ 换行）→ 一个空行
    return text.strip("\n")


def _fill_and_submit(page, title, content, tags, *, before_submit=None):
    """标题→正文→话题→长度校验→提交→界面反馈校验。"""
    content = _normalize_content(content)         # 修连续空行导致的发布失败
    title_el = page.query_selector(SELECTORS["title_input"])
    if not title_el:
        _die("未找到标题输入框（检查 SELECTORS.title_input）")
    _human_type(page, title_el, title)
    page.wait_for_timeout(400)

    content_el = _content_element(page)
    if not content_el:
        _die("未找到正文输入框（检查 SELECTORS.content_*）")
    _human_type(page, content_el, content)
    page.wait_for_timeout(500)
    title_el.click()  # REF waitAndClickTitleInput：回点标题增强稳定性
    _input_tags(page, content_el, tags)

    _check_overflow(page)

    kind, btn = _wait_publish_clickable(page, 15)
    btn.scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    box = btn.bounding_box()
    if before_submit is not None:
        before_submit()
    publish_receipt.mark_submitted()
    if kind == "new" and box:
        # xhs-publish-btn 是宽横条(闭合 Shadow DOM)，内含[暂存离开][发布]两个按钮；
        # 点 host 中心会落在两按钮间隙→无效。发布按钮在右侧约 62% 处（实测像素为品牌红），按坐标点它。
        page.mouse.click(box["x"] + box["width"] * 0.62, box["y"] + box["height"] / 2)
    else:
        try:
            btn.click(force=True)
        except Exception:
            btn.click()
    page.wait_for_timeout(1000)
    _confirm_publish_dialog(page)   # 若弹二次确认框，点确认
    return _wait_publish_success(page, 40)


# --------------------------------------------------------------------------- #
# 命令
# --------------------------------------------------------------------------- #
def _launch(p, headed: bool, base: str | None, proxy: str | None, *, login_assets: bool = True):
    profile = _profile_dir(base)
    profile.mkdir(parents=True, exist_ok=True)
    args = list(LAUNCH_ARGS)
    kwargs = dict(headless=not headed,
                  locale="zh-CN",
                  timezone_id="Asia/Shanghai",
                  args=args)
    if proxy:
        kwargs["proxy"] = {"server": proxy}
    else:
        # 显式直连：Chromium 级屏蔽系统/环境代理（开 VPN 也能用）——同抖音链兜底
        args.append("--no-proxy-server")
    cloak = _cloak_executable()
    if cloak:
        kwargs["executable_path"] = str(cloak)
    elif headed:
        channel = _browser_channel()
        if channel:
            kwargs["channel"] = channel
    last: Exception | None = None
    for attempt in range(2):
        try:
            context = p.chromium.launch_persistent_context(str(profile), **kwargs)
            if login_assets:
                login_transport.install(context, "xiaohongshu")
            return context
        except Exception as e:
            last = e
            if attempt == 0 and "TargetClosed" in type(e).__name__:
                time.sleep(1.2)
                _clear_stale_chrome_locks(profile)
                continue
            raise
    raise last  # pragma: no cover


def cmd_check(_a) -> int:
    ok = True
    try:
        from playwright.sync_api import sync_playwright
        print("✅ playwright 已安装")
        with sync_playwright() as p:
            path = p.chromium.executable_path
            if path and Path(path).exists():
                print(f"✅ chromium 内核：{path}")
            else:
                print("❌ 未安装浏览器内核（playwright install chromium）"); ok = False
    except Exception as e:
        print(f"❌ playwright/内核不可用：{e}"); ok = False
    cloak = _cloak_executable()
    if cloak:
        print(f"✅ CloakBrowser 内核：{cloak}")
    else:
        print("⚠️ 未找到 CloakBrowser（~/.cloakbrowser）；小红书登录可能被 300012")
    print(f"登录态目录：{_profile_dir(None)}")
    return 0 if ok else 3


def _wait_sel(page, selector: str, timeout_ms: int = 15000, what: str = "元素") -> object:
    """等待选择器出现，容忍登录页导航竞态。

    小红书登录页会多次跳转（探索页 → 登录引导），Playwright 在导航瞬间
    查询旧 DOM 会抛 "Execution context was destroyed"——这不是选择器错误，
    是页面在跳。重试直到 deadline 而非一次失败就报错。
    """
    deadline = time.time() + timeout_ms / 1000
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            el = page.wait_for_selector(selector, timeout=2500)
            if el is not None:
                return el
        except Exception as e:  # navigation / context destroyed / timeout
            last_err = e
        page.wait_for_timeout(800)
    if last_err is not None and "Timeout" not in type(last_err).__name__:
        raise last_err
    raise TimeoutError(f"等待 {what} 超时（{timeout_ms}ms）：{selector}")


def _query_safe(page, selector: str):
    """query_selector 的容错版：导航瞬间 context 被销毁会抛异常，这里吞掉返回
    None。裸 query_selector 在页面跳转期会崩，用它做一次性登录态探测更稳。"""
    try:
        return page.query_selector(selector)
    except Exception:
        return None


def _classify_login_page_error(url: str, title: str, body: str = "") -> str | None:
    """Classify only a first-party login error page, never ordinary feed text.

    An error redirect or a generic security title is not evidence of error
    300012. Keep unknown platform failures distinct from an explicit IP warning.
    """
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
    except ValueError:
        return None
    if parsed.scheme != "https" or not (host == "xiaohongshu.com" or host.endswith(".xiaohongshu.com")):
        return None
    error_route = parsed.path.rstrip("/") == "/website-login/error"
    security_title = "安全限制" in title or "安全验证" in title
    if not (error_route or security_title):
        return None
    visible = title + "\n" + body
    codes = parse_qs(parsed.query)
    explicit_code = any("300012" in codes.get(key, []) for key in ("code", "error_code", "errorCode", "errCode"))
    if (explicit_code or re.search(r"(?<!\d)300012(?!\d)", visible)
            or re.search(r"IP\s*存在风险", visible, re.IGNORECASE)):
        return "network_risk"
    if security_title or "安全验证" in body or "安全限制" in body:
        return "security_verification"
    return "login_page_error"


_LOGIN_PAGE_MESSAGES = {
    "network_risk": "小红书明确提示当前网络存在风险。请先在官方客户端确认账号可正常登录，按平台提示处理后再试。",
    "security_verification": "小红书要求额外安全验证，暂未提供二维码。请先在官方客户端完成验证后再试。",
    "login_page_error": "小红书登录页面返回错误，尚未确认具体原因。请稍后手动重试。",
}


def _stop_on_login_page_error(page, status_file: str | None, *, allow_verification: bool = False) -> bool:
    """Read only public error text; never put page URLs or account data in status."""
    try:
        url, title = page.url, page.title() or ""
    except Exception:
        return False  # Navigation can temporarily replace the execution context.
    kind = _classify_login_page_error(url, title)
    if kind is None:
        return False
    try:
        body = page.locator("body").inner_text(timeout=1000)
    except Exception:
        body = ""
    kind = _classify_login_page_error(url, title, body) or kind
    if allow_verification and kind != "network_risk":
        return True  # Leave the official page available for the user's own action.
    message = _LOGIN_PAGE_MESSAGES[kind]
    login_state.write_status(status_file, "error", message)
    _die(message, 4)
    return True


def _login_page_closed(page) -> bool:
    try:
        return page is not None and page.is_closed()
    except Exception:
        return False


def _wait_visible_login(page, qr_out: Path, status_file: str | None, timeout_s: int) -> str:
    """Observe manual login without clicking, reloading, or filling verification.

    The window remains usable when the platform offers a manual verification
    step or no extractable QR. A confirmed network-risk block still terminates.
    """
    deadline = time.monotonic() + timeout_s
    last_state = ""
    qr_meta = None
    last_capture = -3.0
    while time.monotonic() < deadline:
        if _login_page_closed(page):
            return "closed"
        verification = _stop_on_login_page_error(page, status_file, allow_verification=True)
        try:
            location = urlsplit(page.url)
            official = (location.scheme == "https" and location.hostname in ("www.xiaohongshu.com", "xiaohongshu.com")
                        and location.username is None and location.password is None)
        except (ValueError, AttributeError):
            official = False
        if official and not verification and _is_logged_in(page):
            return "success"
        qr = _query_safe(page, SELECTORS["qrcode"]) if official and not verification else None
        captured = False
        if qr is not None:
            if time.monotonic() - last_capture >= 3:
                qr_meta = login_qr.capture_element(qr, qr_out)
                last_capture = time.monotonic()
                captured = True
            state = "qr_ready" if qr_meta else "verifying"
        else:
            qr_meta = None
            last_capture = -3.0
            state = "verifying"
        if state != last_state or captured:
            message = ("请用小红书 App 扫码，也可在已打开的浏览器窗口完成登录。" if state == "qr_ready"
                       else "请在已打开的小红书浏览器窗口完成登录或安全验证。")
            login_state.write_status(status_file, state, message, qr=str(qr_out) if state == "qr_ready" else "", qr_meta=qr_meta)
            last_state = state
        page.wait_for_timeout(1000)
    return "expired"


def cmd_login(a) -> int:
    """headless 友好登录：把二维码抠成 PNG 供扫码，轮询登录成功后持久化 cookie。
    REF login.go FetchQrcodeImage/WaitForLogin。远程无桌面环境靠图片扫码，非有头窗口。"""
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        _die(f"需要 playwright：{e}", 3)

    qr_out = Path(a.qr_out).expanduser() if a.qr_out else DEFAULT_QR_OUT
    timeout_s = a.timeout or 180
    sf = getattr(a, "status_file", None)
    login_state.write_status(sf, "starting", "正在启动…")
    lock = _ProfileLock(_profile_dir(a.profile_base))
    try:
        lock.acquire(90)
    except TimeoutError:
        login_state.write_status(sf, "error", "账号页正在校验小红书，登录目录被占用。请关闭弹窗，等 10 秒再点登录。")
        _die("小红书登录目录正被占用（多半是后台 whoami）", 1)

    try:
        with sync_playwright() as p:
            try:
                ctx = _launch(p, headed=a.headed, base=a.profile_base, proxy=_proxy(a.proxy, a.no_proxy))
            except Exception:
                message = "无法启动登录浏览器，请检查浏览器组件是否完整，并关闭占用此账号的窗口后重试。"
                login_state.write_status(sf, "error", message)
                _die(message, 3)
            page = None
            completed_message = ""
            try:
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                try:
                    page.goto(EXPLORE_URL, wait_until="domcontentloaded")
                except Exception:
                    if _login_page_closed(page):
                        login_state.write_status(sf, "expired", "登录窗口已关闭，本次登录已结束。")
                        return 1
                    verification = _stop_on_login_page_error(page, sf, allow_verification=a.headed)
                    if not (a.headed and verification):
                        message = "无法打开小红书登录页面，请检查网络连接或稍后重试。"
                        login_state.write_status(sf, "error", message)
                        _die(message)

                if a.headed:
                    result = _wait_visible_login(page, qr_out, sf, timeout_s)
                    if result == "success":
                        completed_message = "登录成功"
                        return 0
                    message = ("登录窗口已关闭，本次登录已结束。" if result == "closed"
                               else "等待浏览器登录超时，请重新连接后在窗口中完成登录。")
                    login_state.write_status(sf, "expired", message)
                    return 1

                # 等待页面稳定并完成可能的跳转（登录引导 / 风险拦截 / 已登录态）
                for _ in range(10):
                    page.wait_for_timeout(800)
                    _stop_on_login_page_error(page, sf)
                    if _is_logged_in(page):
                        break

                # 已登录直接返回（页面可能仍在跳转，查询失败按未登录继续走登录流程）
                if _is_logged_in(page):
                    completed_message = "已登录"
                    return 0

                # 抠二维码存 PNG（元素截图，不依赖 src 格式，最稳）
                try:
                    qr = _wait_sel(page, SELECTORS["qrcode"], 20000, "登录二维码")
                except Exception:
                    # 超时后先复查是不是风险拦截页（重定向晚到的情况），别误报「页面结构变了」
                    _stop_on_login_page_error(page, sf)
                    message = "小红书登录页未提供二维码，可能正在验证或页面已更新。请稍后手动重试。"
                    login_state.write_status(sf, "error", message)
                    _die(message)
                qr_out.parent.mkdir(parents=True, exist_ok=True)
                qr_meta = login_qr.capture_element(qr, qr_out)
                if not qr_meta:
                    _stop_on_login_page_error(page, sf)
                    message = "小红书登录页尚无可扫描二维码，请尝试浏览器登录并查看官方验证提示。"
                    login_state.write_status(sf, "error", message)
                    _die(message)
                login_state.write_status(sf, "qr_ready", "二维码已就绪，请扫码", qr=str(qr_out), qr_meta=qr_meta)
                print(f"📱 二维码已保存：{qr_out}")
                print(f"   用小红书 App 扫码登录。若走 Easel Web UI，可在 outputs 里查看这张图。")
                print(f"   （二维码有时效，约几分钟；过期请重跑 login）")
                print(f"⏳ 等待扫码确认（最长 {timeout_s}s）...", file=sys.stderr)

                # 轮询登录成功（扫码成功瞬间页面会跳转，查询崩了是正常的，重试继续等）
                deadline = time.time() + timeout_s
                while time.time() < deadline:
                    _stop_on_login_page_error(page, sf)
                    if _is_logged_in(page):
                        completed_message = "登录成功"
                        return 0
                    if login_state.report_scan(sf, page):
                        page.wait_for_timeout(2000)
                        continue
                    current_qr = _query_safe(page, SELECTORS["qrcode"])
                    current_meta = login_qr.capture_element(current_qr, qr_out) if current_qr is not None else None
                    login_state.write_status(sf, "qr_ready" if current_meta else "verifying",
                                            "二维码已就绪，请扫码" if current_meta else "请查看官方页面是否要求安全验证。",
                                            qr=str(qr_out) if current_meta else "", qr_meta=current_meta)
                    page.wait_for_timeout(2000)
                login_state.write_status(sf, "expired", "二维码超时未扫")
                print(f"⏱️ {timeout_s}s 内未检测到登录成功（二维码可能已过期）。请重跑 login 再扫。",
                      file=sys.stderr)
                return 1
            except Exception:
                if _login_page_closed(page):
                    login_state.write_status(sf, "expired", "登录窗口已关闭，本次登录已结束。")
                    return 1
                message = "登录流程意外中断，请关闭登录窗口后重新连接。"
                login_state.write_status(sf, "error", message)
                _die(message)
            finally:
                try:
                    ctx.close()
                except Exception:
                    if completed_message:
                        message = "已在平台完成登录，但本地登录资料未能保存完成，请重新连接后核验。"
                        login_state.write_status(sf, "error", message)
                        _die(message, 3)
                if completed_message:
                    # Persistent Chromium flushes the profile during close. Do not
                    # announce success while it still owns or writes that profile.
                    login_state.write_status(sf, "success", completed_message)
                    try:
                        qr_out.unlink()
                    except OSError:
                        pass
                    print("✅ 登录成功，登录资料已保存在本机")
    finally:
        lock.release()


def _plan_lines(kind: str, title: str, content: str, media: list[str], tags: list[str]) -> list[str]:
    tab = "上传图文" if kind == "image" else "上传视频"
    tl = calc_title_length(title) if title else 0
    lines = [
        f"发布类型：{kind}    发布页：{PUBLISH_URL}",
        f"标题：{title}（长度 {tl}/{TITLE_MAX}{'  ⚠️超限' if tl > TITLE_MAX else ''}）",
        f"正文：{content[:40]}{'...' if len(content) > 40 else ''}",
        f"媒体：{media}",
        f"话题：{tags}",
        "步骤：",
        f"  1. goto {PUBLISH_URL} → WaitLoad+DOMStable",
        f"  2. 点 tab「{tab}」（重试+遮挡检测）",
        f"  3. {'逐图上传等预览(≤60s/张)' if kind == 'image' else '上传视频等处理(≤10min)'}",
        "  4. 输标题/正文（逐字符）+ 话题联想点选",
        "  5. 平台 DOM 长度校验",
        "  6. 等发布按钮可点击（新版<xhs-publish-btn>/旧版.bg-red）→ 点击",
        "  7. 提交校验：检查提交提示/表单复位，再读回本人作品列表",
        "  8. 排除发前已有作品，精确核对标题、时间、审核状态与公开权限后生成回执",
    ]
    return lines


def cmd_plan(a) -> int:
    kind = "video" if a.video else "image"
    media = [str(Path(a.video).expanduser())] if a.video else (
        [s.strip() for s in (a.images or "").split(",") if s.strip()])
    tags = [t.strip() for t in (a.tags or "").split(",") if t.strip()]
    for ln in _plan_lines(kind, a.title or "<title>", a.content or "<content>", media, tags):
        print(ln)
    return 0


def _publish(a, kind: str) -> int:
    if not a.title:
        _die("--title 必填")
    if calc_title_length(a.title) > TITLE_MAX:
        _die(f"标题过长（{calc_title_length(a.title)}/{TITLE_MAX}），请精简")
    if kind == "image":
        media = _abspaths(a.images)
        if not media:
            _die("--images 至少一张图片")
    else:
        if not a.video:
            _die("--video 必填")
        media = [_abspaths(a.video)[0]]
    tags = [t.strip() for t in (a.tags or "").split(",") if t.strip()]

    # 出站内容安全闸门：真发前扫描标题/正文/话题，检出 API key/内部 URL/代理 IP/模型名/
    # "由 AI 生成" 等内部设置泄露即阻止发布（dry-run 只告警）。--allow-unsafe 手动放行。
    content_guard.guard_or_die([a.title, a.content, " ".join(tags)],
                               exec_mode=bool(a.exec),
                               allow_unsafe=getattr(a, "allow_unsafe", False),
                               label="小红书发布内容")

    if not a.exec:
        print("dry-run（加 --exec 真正发布）：\n")
        for ln in _plan_lines(kind, a.title, a.content or "", media, tags):
            print(ln)
        return 0

    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    except Exception as e:
        _die(f"需要 playwright：{e}", 3)
    lock = _ProfileLock(_profile_dir(a.profile_base))
    try:
        lock.acquire(90)
    except TimeoutError:
        _die("小红书登录目录正被占用，请稍后再发")
    try:
        with sync_playwright() as p:
            ctx = _launch(p, headed=a.headed, base=a.profile_base, proxy=_proxy(a.proxy, a.no_proxy))
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.set_default_timeout(300000)
            since_ms = None
            signal = ""

            def before_submit():
                nonlocal since_ms
                since_ms = int(time.time() * 1000)

            try:
                snapshot_ids = xhs_readback.capture_xhs_snapshot(page)
                page.goto(PUBLISH_URL, wait_until="domcontentloaded")
                page.wait_for_timeout(1500)
                # 登录态探测容忍导航竞态：发布页也可能仍在跳转，跳转瞬间裸 query 会抛
                # context-destroyed；重试几次再据 url 判定「未登录」，避免误报。
                logged = False
                for _ in range(4):
                    if _query_safe(page, SELECTORS["login_ok"]) is not None:
                        logged = True
                        break
                    page.wait_for_timeout(500)
                if not logged and "login" in page.url.lower():
                    _die("未登录，请先 `login` 扫码")
                if kind == "image":
                    _click_publish_tab(page, "上传图文")
                    page.wait_for_timeout(1000)
                    _upload_images(page, media)
                else:
                    _click_publish_tab(page, "上传视频")
                    page.wait_for_timeout(1000)
                    _upload_video(page, media[0])
                try:
                    signal = _fill_and_submit(page, a.title, a.content or "", tags,
                                              before_submit=before_submit)
                except (Exception, SystemExit):
                    if since_ms is None:
                        raise
                    # Submission can succeed even if the toast/navigation wait fails.
                    # Verify the work instead of clicking publish again.
                    print("提交界面反馈未确认，正在只读核对本人作品列表。", file=sys.stderr)
                result = xhs_readback.verify_xhs_publish(page, title=a.title, since_ms=since_ms,
                                                        snapshot_ids=snapshot_ids)
                receipt = xhs_readback.receipt_from_result(result, signal=signal)
            except PWTimeout as e:
                _die(f"步骤超时（选择器可能已失效，检查 SELECTORS）：{e}")
            finally:
                if not a.keep_open:
                    ctx.close()
    finally:
        lock.release()
    publish_receipt.emit(receipt)
    print(receipt["message"])
    return 0 if receipt["outcome"] in {"published", "submitted"} else 5


@publish_receipt.publishing_command("xiaohongshu")
def cmd_publish(a) -> int:
    return _publish(a, "image")


@publish_receipt.publishing_command("xiaohongshu")
def cmd_publish_video(a) -> int:
    return _publish(a, "video")


def cmd_verify_publish(a) -> int:
    """Recheck an existing submission; never upload, fill, or click publish."""
    result = xhs_readback.ReadbackResult("readback_error")
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            ctx = _launch(p, headed=a.headed, base=a.profile_base, proxy=_proxy(a.proxy, a.no_proxy))
            try:
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                result = xhs_readback.verify_xhs_publish(page, title=a.title, since_ms=a.since_ms,
                                                        content_id=a.content_id or "",
                                                        until_ms=getattr(a, "until_ms", None))
            finally:
                ctx.close()
    except KeyboardInterrupt:
        result = xhs_readback.ReadbackResult("unverified")
    except Exception:
        # A recheck error is not evidence that the earlier publish failed.
        result = xhs_readback.ReadbackResult("readback_error")
    receipt = publish_receipt.emit(xhs_readback.receipt_from_result(result, read_only=True))
    print(receipt["message"])
    return 0 if receipt["outcome"] in {"published", "submitted"} else 5


def cmd_whoami(a) -> int:
    """真校验登录态 + 读账号昵称/头像，输出单行 JSON（供 Web 后端解析）。
    xhs 须直连（--no-proxy），走代理会被判风险。抽不到昵称时 name 空但 loggedIn 仍准。"""
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        print(json.dumps({"loggedIn": False, "name": "", "avatar": "", "error": f"playwright:{e}"}))
        return 0
    result = {"loggedIn": False, "name": "", "avatar": ""}
    lock = _ProfileLock(_profile_dir(a.profile_base))
    try:
        lock.acquire(4)
    except TimeoutError:
        result["error"] = "profile-busy"
        print(json.dumps(result, ensure_ascii=False))
        return 0
    try:
        with sync_playwright() as p:
            ctx = _launch(p, headed=False, base=a.profile_base, proxy=_proxy(a.proxy, a.no_proxy))
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            try:
                account = _authenticated_account(ctx)
                if account is not None:
                    result["loggedIn"] = True
                    if not all(_account_identity(account).values()):
                        account = _self_profile_account(ctx, account)
                    result.update(_account_identity(account))
                    if not all((result["name"], result["avatar"])):
                        try:
                            fallback = _page_account_identity(page, account.get("userId"))
                            for field in ("name", "avatar"):
                                if not result[field]:
                                    result[field] = fallback[field]
                        except Exception:
                            pass
                else:
                    page.goto(EXPLORE_URL, wait_until="domcontentloaded")
                    try:  # 等登录态元素出现（已登录会很快命中；未登录则短等后判定）
                        page.wait_for_selector(SELECTORS["login_ok"], timeout=4000)
                    except Exception:
                        pass
                    host = urlsplit(page.url).hostname or ''
                    first_party = host == 'xiaohongshu.com' or host.endswith('.xiaohongshu.com')
                    identity = _query_safe(page, SELECTORS["login_ok"])
                    logged = bool(first_party and identity is not None and identity.is_visible())
                    result["loggedIn"] = logged
                    if not logged:
                        kind = _classify_login_page_error(page.url, page.title() or '')
                        login = _query_safe(page, '.login-container, .login-btn')
                        if not first_party:
                            result['error'] = '页面未处于小红书站点，暂时无法确认账号状态。'
                        elif kind:
                            result['error'] = _LOGIN_PAGE_MESSAGES[kind]
                        elif not (first_party and login is not None and login.is_visible()):
                            result['error'] = '未识别到可见账号或登录入口，暂时无法确认会话状态，请稍后重试。'
                        else:
                            result['reason'] = 'login_required'
                    if logged:
                        img = page.query_selector('.main-container .user img.reds-img')
                        if img:
                            result["avatar"] = img.get_attribute("src") or ""
                        a_el = page.query_selector('.main-container .user a[href^="/user/profile/"]')
                        href = a_el.get_attribute("href") if a_el else None
                        if href:  # 昵称在个人主页，explore 页只有头像
                            try:
                                page.goto("https://www.xiaohongshu.com" + href,
                                          wait_until="domcontentloaded")
                                try:
                                    page.wait_for_selector(".user-name", timeout=4000)
                                except Exception:
                                    pass
                                for sel in (".user-name", ".user-nickname",
                                            'div[class*="nickname"]', ".info .name"):
                                    el = page.query_selector(sel)
                                    if el:
                                        t = (el.inner_text() or "").strip()
                                        if t:
                                            result["name"] = t.splitlines()[0][:40]
                                            break
                            except Exception:
                                pass
            finally:
                ctx.close()
    except Exception as e:  # noqa: BLE001 — whoami 永远输出 JSON，异常视作未登录
        result["error"] = str(e)
    finally:
        lock.release()
    print(json.dumps(result, ensure_ascii=False))
    return 0


def cmd_selftest(_a) -> int:
    print("xhs_publish 自检（离线）...", file=sys.stderr)
    # 标题长度算法（REF title.go）
    assert calc_title_length("") == 0
    assert calc_title_length("abcd") == 2, "4 ASCII → (4+1)//2 = 2"
    assert calc_title_length("你好") == 2, "2 全角 → 4 字节 → 2"
    assert calc_title_length("你" * 20) == 20, "20 全角 → 20（上限）"
    assert calc_title_length("a") == 1
    # 选择器字典完整
    need = ["login_ok", "qrcode", "creator_tab", "upload_input_first", "img_preview",
            "title_input", "content_quill", "topic_item", "publish_btn_new", "publish_btn_old"]
    for k in need:
        assert k in SELECTORS and SELECTORS[k], f"缺选择器 {k}"
    # 路径解析
    try:
        _abspaths("/no/such/file_xyz.jpg")
        raise AssertionError("不存在文件未报错")
    except SystemExit:
        pass
    # profile 目录路由
    assert _profile_dir(None).name == PROFILE_NAME
    assert "cloak-research-profile" not in str(_profile_dir(None))
    cloak = _cloak_executable()
    assert cloak is None or cloak.is_file()
    import shutil
    import tempfile
    tmp = Path(tempfile.mkdtemp(prefix="easel-xhs-lock-"))
    try:
        held = _ProfileLock(tmp)
        held.acquire(1)
        blocked = _ProfileLock(tmp)
        try:
            blocked.acquire(0.3)
            raise AssertionError("第二把锁应失败")
        except TimeoutError:
            pass
        finally:
            blocked.release()
        held.release()
        held.acquire(1)
        held.release()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    # 代理逻辑
    assert _proxy(None, True) is None, "--no-proxy 应禁用"
    assert _proxy("http://x:1", False) == "http://x:1", "显式代理优先"
    # plan 渲染
    lines = _plan_lines("image", "标题", "正文", ["/a.jpg"], ["#tag"])
    assert any("上传图文" in ln for ln in lines) and any("提交校验" in ln for ln in lines)
    lines_v = _plan_lines("video", "t", "c", ["/a.mp4"], [])
    assert any("上传视频" in ln for ln in lines_v)
    print("✅ selftest 通过（标题算法 + 选择器字典 + 路径/代理/路由 + plan 渲染）")
    return 0


def main() -> int:
    login_state.configure_stdio()
    ap = argparse.ArgumentParser(
        description="小红书发布（Playwright，headless 可用；流程移植自 xiaohongshu-mcp）",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")

    def add_common(p):
        p.add_argument("--profile-base", help="登录态根目录（默认 ~/.easel-browser-profiles）")
        p.add_argument("--proxy", help="外网代理（默认取 env，小红书是外网需代理）")
        p.add_argument("--no-proxy", action="store_true", help="禁用代理")

    def add_content(p):
        p.add_argument("--title", help="标题（≤20 全角）")
        p.add_argument("--content", help="正文")
        p.add_argument("--images", help="图片路径，逗号分隔（图文发布）")
        p.add_argument("--video", help="视频路径（视频发布）")
        p.add_argument("--tags", help="话题，逗号分隔（如 'AI,教程'）")
        p.add_argument("--exec", action="store_true", help="真正发布（默认 dry-run）")
        p.add_argument("--allow-unsafe", action="store_true",
                       help="放行内容安全闸门（检出内部设置泄露也照发，谨慎）")
        p.add_argument("--headed", action="store_true", help="有头模式（首次校验选择器用）")
        p.add_argument("--keep-open", action="store_true", help="发布后不关浏览器")

    sub.add_parser("check", help="检查 playwright/内核").set_defaults(func=cmd_check)

    p = sub.add_parser("login", help="扫码登录并持久化（headless：抠二维码成图片）")
    add_common(p)
    p.add_argument("--qr-out", help=f"二维码图片输出路径（默认 {DEFAULT_QR_OUT}）")
    p.add_argument("--status-file", help="登录状态 JSON 输出路径（供 Web 后端轮询）")
    p.add_argument("--timeout", type=int, help="等待扫码超时秒数（默认 180）")
    p.add_argument("--headed", action="store_true", help="有头模式（本地有桌面时可窗口内扫）")
    p.set_defaults(func=cmd_login)

    p = sub.add_parser("plan", help="发布步骤预览（离线）")
    add_content(p)
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser("publish", help="图文发布")
    add_common(p); add_content(p)
    p.set_defaults(func=cmd_publish)

    p = sub.add_parser("publish-video", help="视频发布")
    add_common(p); add_content(p)
    p.set_defaults(func=cmd_publish_video)

    def millisecond_arg(value):
        try:
            parsed = int(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError("必须是毫秒时间戳整数") from exc
        if not xhs_readback.valid_since_ms(parsed):
            raise argparse.ArgumentTypeError("必须是毫秒时间戳，不能使用秒或负数")
        return parsed

    def content_id_arg(value):
        if value and not xhs_readback.NOTE_ID.fullmatch(value):
            raise argparse.ArgumentTypeError("--content-id 必须是 24 位小写十六进制笔记编号")
        return value

    p = sub.add_parser("verify-publish", help="只读核实已提交笔记，不会重新上传或发布")
    add_common(p)
    p.add_argument("--title", required=True, help="提交时的完整标题")
    p.add_argument("--since-ms", required=True, type=millisecond_arg, help="提交开始的毫秒时间戳")
    p.add_argument("--until-ms", type=millisecond_arg, help="原提交结束的毫秒时间戳，限制无编号笔记的匹配范围")
    p.add_argument("--content-id", default="", type=content_id_arg, help="已知笔记编号；填写后仅核实该笔记")
    p.add_argument("--headed", action="store_true", help="有头模式")
    p.set_defaults(func=cmd_verify_publish)

    p = sub.add_parser("whoami", help="真校验登录态 + 读昵称/头像（输出 JSON）")
    add_common(p)
    p.set_defaults(func=cmd_whoami)

    sub.add_parser("selftest", help="离线自检").set_defaults(func=cmd_selftest)

    a = ap.parse_args()
    if a.cmd == "verify-publish" and a.until_ms is not None and a.until_ms < a.since_ms:
        ap.error("--until-ms 不能早于 --since-ms")
    if not getattr(a, "func", None):
        ap.print_help()
        return 1
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
