"""受控链接读取：先普通 HTTP；反爬站点回退到本机有头浏览器。

边界（与爆款拆解方案一致）：仅 http(s)、拦截私有/回环地址（含重定向逐跳）、
响应大小与时间上限、不登录任何第三方、不持久化 cookie、只返回文本。
知乎等反爬站点对无头浏览器同样返回 403（实测），本机有头系统浏览器可读。
"""
from __future__ import annotations

import concurrent.futures
import ipaddress
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
MAX_HTML_BYTES = 2_000_000
MAX_TEXT_CHARS = 40_000
HTTP_TIMEOUT = 15
BROWSER_TIMEOUT_MS = 30_000
BROWSER_WAIT_MS = 2_500
BROWSER_IDLE_SECONDS = 120
MIN_HTTP_TEXT = 400  # 低于此字数视为验证页/空壳，转浏览器
MIN_READ_TEXT = 300  # 浏览器各级读取统一接受门槛
MIN_RULE_TEXT = 40  # 命中站点规则时，规则内容的最低字数（不足以判定为空壳，继续降级）
BLOCKED_MARKERS = (
    '安全验证', '请求被拦截', '访问异常', '请输入验证码', '拖动滑块', '完成验证',
    '人机验证', '异常流量', 'Just a moment', 'Verify you are human', 'Attention Required',
)

# 按站点的正文选择器（拿不到时回退通用提取；不用登录态，仅匿名可见内容）。
SITE_RULES: dict[str, dict[str, str]] = {
    'www.zhihu.com': {'title': 'h1.QuestionHeader-title', 'text': '.Question-mainColumn'},
    'www.bilibili.com': {'title': 'h1.video-title', 'text': '#v_desc, .desc-info-text, .video-desc-container'},
    'www.xiaohongshu.com': {'title': '#detail-title, h1', 'text': '.note-content, #detail-desc, .desc'},
}

# 项目内置浏览器：平台登录配置（发布/统计技能同一套；有登录态时无需登录墙也能读）。
PROFILE_ROOT = Path.home() / '.easel-browser-profiles'
SITE_PROFILES: dict[str, str] = {
    'www.zhihu.com': 'ZhihuProfile',
    'zhuanlan.zhihu.com': 'ZhihuProfile',
    'www.xiaohongshu.com': 'XiaohongshuProfile',
    'www.douyin.com': 'DouyinProfile',
    'v.douyin.com': 'DouyinProfile',
    'www.kuaishou.com': 'KuaishouProfile',
    'mp.weixin.qq.com': 'WeixinMpProfile',
    'channels.weixin.qq.com': 'ChannelsProfile',
}


def profile_for_url(url: str, *, root: Path | None = None) -> Path | None:
    """命中平台且有已登录配置目录时返回该配置，否则 None（走匿名通道）。"""
    host = (urllib.parse.urlsplit(url).hostname or '').lower()
    name = SITE_PROFILES.get(host)
    if not name:
        return None
    base = root if root is not None else PROFILE_ROOT
    candidate = base / name
    return candidate if candidate.is_dir() else None


class LinkError(ValueError):
    pass


def _host_blocked(host: str) -> bool:
    name = (host or '').strip().lower()
    if not name or name == 'localhost' or name.endswith('.local') or name.endswith('.internal'):
        return True
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast


def validate_url(raw: str) -> str:
    value = (raw or '').strip()
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise LinkError('只支持 http/https 链接')
    if _host_blocked(parsed.hostname):
        raise LinkError('该地址不允许读取（仅公网 http/https）')
    return value


class _RedirectGuard(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        if target.scheme not in ('http', 'https') or not target.hostname or _host_blocked(target.hostname):
            raise LinkError('重定向目标不允许读取')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _TextExtractor(HTMLParser):
    BLOCKS = {'p', 'div', 'section', 'article', 'li', 'br', 'h1', 'h2', 'h3', 'h4',
              'blockquote', 'pre', 'tr', 'figcaption', 'main'}
    SKIP = {'script', 'style', 'noscript', 'svg', 'template'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ''
        self.parts: list[str] = []
        self._in_title = False
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag == 'title':
            self._in_title = True
        elif self._skip == 0 and tag in self.BLOCKS:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == 'title':
            self._in_title = False

    def handle_data(self, data):
        if self._skip:
            return
        text = data.strip()
        if not text:
            return
        if self._in_title:
            self.title = (self.title + ' ' + text).strip()[:200]
        elif len(self.parts) < 20_000:
            self.parts.append(text + ' ')

    def result(self) -> tuple[str, str]:
        return self.title, _normalize_text(''.join(self.parts))


def _normalize_text(raw: str) -> str:
    lines: list[str] = []
    for line in raw.split('\n'):
        cleaned = re.sub(r'\s+', ' ', line).strip()
        if cleaned and (not lines or lines[-1] != cleaned):
            lines.append(cleaned)
    return '\n'.join(lines)


def extract_html(html: str) -> dict[str, str]:
    parser = _TextExtractor()
    try:
        parser.feed(html)
    except Exception:
        pass
    title, text = parser.result()
    return {'title': title[:200], 'text': text}


def _decode(raw: bytes, content_type: str) -> str:
    match = re.search(r'charset=([\w-]+)', content_type or '', re.I)
    for charset in filter(None, [match.group(1) if match else None, 'utf-8', 'gbk']):
        try:
            return raw.decode(charset)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode('utf-8', errors='replace')


def _looks_blocked(page: dict[str, Any] | None) -> bool:
    """反爬/验证页特征：命中则视为未读到内容，继续降级而不是当成功。"""
    if not page:
        return True
    text = str(page.get('text') or '')
    head = text[:600]
    return any(marker in head for marker in BLOCKED_MARKERS)


class LinkReader:
    """读取一条链接的标题与正文；可注入 http_fetch/browser_fetch 供测试。"""

    def __init__(self, *, http_fetch: Callable[[str], dict[str, Any]] | None = None,
                 browser_fetch: Callable[[str], dict[str, Any]] | None = None,
                 browser_idle_seconds: float = BROWSER_IDLE_SECONDS):
        self._http_fetch = http_fetch or self._http_read
        self._browser_fetch = browser_fetch or self._browser_read
        self._idle_seconds = browser_idle_seconds
        self._browser_lock = threading.Lock()
        self._browser = None
        self._playwright = None
        self._browser_last_used = 0.0
        self._reaper_alive = False
        # Playwright 的 sync API 绑定创建线程：所有浏览器操作串行跑在同一个专属线程上
        # （HTTP 路由经 asyncio.to_thread 每次可能换线程，直接复用会 "Cannot switch to a different thread"）。
        self._browser_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix='easel-link-browser')
        # 登录配置读取单独一个线程：同线程里无法同时存在两个 sync Playwright 实例。
        self._profile_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix='easel-link-profile')

    def read(self, raw_url: str) -> dict[str, Any]:
        try:
            url = validate_url(raw_url)
        except LinkError as exc:
            return self._result(False, None, '', '', str(raw_url or '')[:2048], str(exc))
        http_error = '普通读取失败'
        host = urllib.parse.urlsplit(url).hostname or ''
        # 有站点规则的域名（知乎/B站等 JS 页面）跳过 HTTP：直接走浏览器阶梯，避免拿到壳页或压缩流。
        if not SITE_RULES.get(host):
            try:
                page = self._http_fetch(url)
                if page and int(page.get('chars') or 0) >= MIN_HTTP_TEXT and not _looks_blocked(page):
                    return self._result(True, 'http', page.get('title') or '', page.get('text') or '',
                                        page.get('url') or url, None)
                http_error = f"页面正文过少或疑似验证页（{int((page or {}).get('chars') or 0)} 字）"
            except LinkError as exc:
                return self._result(False, None, '', '', url, str(exc))
            except Exception as exc:
                http_error = _plain(exc)
        try:
            page = self._browser_executor.submit(self._browser_fetch, url).result(
                timeout=BROWSER_TIMEOUT_MS / 1000 + BROWSER_WAIT_MS / 1000 + 90)
            if page and int(page.get('chars') or 0) >= MIN_READ_TEXT and not _looks_blocked(page):
                return self._result(True, 'browser', page.get('title') or '', page.get('text') or '',
                                    page.get('url') or url, None)
            return self._result(False, None, '', '', url,
                                f"浏览器读取未取到有效正文（{http_error}）。请把正文粘贴进来再试。")
        except Exception as exc:
            return self._result(False, None, '', '', url,
                                f"链接读取失败：{_plain(exc)}；普通读取：{http_error}。请把正文粘贴进来再试。")

    @staticmethod
    def _result(ok: bool, source: str | None, title: str, text: str, url: str, reason: str | None) -> dict[str, Any]:
        return {'ok': ok, 'source': source, 'title': title[:200], 'text': text[:MAX_TEXT_CHARS],
                'chars': len(text[:MAX_TEXT_CHARS]), 'url': url[:2048], 'reason': reason}

    # ---- 普通 HTTP ----
    def _http_read(self, url: str) -> dict[str, Any]:
        request = urllib.request.Request(url, headers={
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
            'Accept-Encoding': 'gzip, deflate',  # 不广告 br：urllib 不解压 brotli
        })
        opener = urllib.request.build_opener(_RedirectGuard())
        with opener.open(request, timeout=HTTP_TIMEOUT) as response:
            raw = response.read(MAX_HTML_BYTES + 1)
            final_url = response.geturl()
            content_type = response.headers.get('Content-Type', '')
            encoding = (response.headers.get('Content-Encoding') or '').lower()
        if encoding == 'gzip':
            import gzip
            raw = gzip.decompress(raw)
        elif encoding == 'deflate':
            import zlib
            raw = zlib.decompress(raw, -zlib.MAX_WBITS)
        if len(raw) > MAX_HTML_BYTES:
            raw = raw[:MAX_HTML_BYTES]
        html = _decode(raw, content_type)
        extracted = extract_html(html)
        text = extracted['text'][:MAX_TEXT_CHARS]
        return {'title': extracted['title'], 'text': text, 'chars': len(text), 'url': final_url}

    # ---- 有头系统浏览器（匿名、用完即关/闲置回收） ----
    def _ensure_browser(self):
        with self._browser_lock:
            if self._browser is not None:
                self._browser_last_used = time.time()
                return
            from playwright.sync_api import sync_playwright
            self._playwright = sync_playwright().start()
            last_error: Exception | None = None
            for channel in ('msedge', 'chrome'):
                try:
                    self._browser = self._playwright.chromium.launch(
                        channel=channel, headless=False,
                        args=['--disable-blink-features=AutomationControlled'])
                    break
                except Exception as exc:  # 没装该浏览器时尝试下一个
                    last_error = exc
                    self._browser = None
            if self._browser is None:
                self._playwright.stop()
                self._playwright = None
                raise LinkError(f'本机未找到可用的系统浏览器（Edge/Chrome）：{_plain(last_error)}')
            self._browser_last_used = time.time()
            if not self._reaper_alive:
                self._reaper_alive = True
                threading.Thread(target=self._reap_idle, daemon=True, name='easel-link-reaper').start()

    def _reap_idle(self):
        try:
            while True:
                time.sleep(15)
                with self._browser_lock:
                    idle = self._browser is not None and time.time() - self._browser_last_used > self._idle_seconds
                if idle:
                    self._browser_executor.submit(self._close_browser)
                    return
        finally:
            self._reaper_alive = False

    def _close_browser(self):
        """在专属浏览器线程上关闭 Playwright（sync API 的线程亲和）。"""
        with self._browser_lock:
            try:
                if self._browser is not None:
                    self._browser.close()
            except Exception:
                pass
            self._browser = None
            try:
                if self._playwright is not None:
                    self._playwright.stop()
            except Exception:
                pass
            self._playwright = None

    def close(self):
        try:
            self._browser_executor.submit(self._close_browser).result(timeout=20)
        except Exception:
            pass

    def _browser_read(self, url: str) -> dict[str, Any]:
        """浏览器读取阶梯：命中平台的已登录配置（无头→有头）→ 匿名有头通道兜底。"""
        errors: list[str] = []
        profile = profile_for_url(url)
        if profile is not None:
            for headless in (True, False):
                label = '已登录配置·无头' if headless else '已登录配置·有头'
                try:
                    data = self._profile_executor.submit(self._read_with_profile, url, profile, headless=headless).result(
                        timeout=BROWSER_TIMEOUT_MS / 1000 + BROWSER_WAIT_MS / 1000 + 60)
                    if data and int(data.get('chars') or 0) >= MIN_READ_TEXT and not _looks_blocked(data):
                        return data
                    hint = '疑似验证页' if _looks_blocked(data) else f"{int((data or {}).get('chars') or 0)} 字"
                    errors.append(f'{label}未取到有效正文（{hint}）')
                except Exception as exc:
                    errors.append(f'{label}失败：{_plain(exc)}')
        try:
            data = self._read_ephemeral(url)
            if data and int(data.get('chars') or 0) >= MIN_READ_TEXT and not _looks_blocked(data):
                return data
            hint = '疑似验证页' if _looks_blocked(data) else f"{int((data or {}).get('chars') or 0)} 字"
            errors.append(f'匿名有头通道未取到有效正文（{hint}）')
        except Exception as exc:
            errors.append(f'匿名有头通道失败：{_plain(exc)}')
        raise LinkError('；'.join(errors) or '浏览器读取失败')

    def _read_with_profile(self, url: str, profile_dir: Path, *, headless: bool) -> dict[str, Any]:
        """用项目内置的持久登录配置读取（与发布/统计技能同一套 Profile 与启动参数）。"""
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                str(profile_dir), headless=headless,
                args=['--no-sandbox', '--disable-blink-features=AutomationControlled'])
            try:
                page = context.new_page()
                return self._extract_page(page, url)
            finally:
                try:
                    context.close()
                except Exception:
                    pass

    def _read_ephemeral(self, url: str) -> dict[str, Any]:
        self._ensure_browser()
        with self._browser_lock:
            if self._browser is None:
                raise LinkError('浏览器实例不可用')
            page = self._browser.new_page(locale='zh-CN')
        try:
            return self._extract_page(page, url)
        finally:
            try:
                page.close()
            except Exception:
                pass

    def _extract_page(self, page, url: str) -> dict[str, Any]:
        page.goto(url, wait_until='domcontentloaded', timeout=BROWSER_TIMEOUT_MS)
        final_host = urllib.parse.urlsplit(page.url).hostname or ''
        if _host_blocked(final_host):
            raise LinkError('重定向目标不允许读取')
        page.wait_for_timeout(BROWSER_WAIT_MS)
        # 关掉遮挡的登录弹窗（弹窗只挡视线）；Esc 对所有站点无害。
        try:
            page.keyboard.press('Escape')
            page.evaluate(
                """() => {
                    for (const el of document.querySelectorAll('[aria-label=关闭], .Modal-closeButton, .Button.Modal-closeButton')) el.click();
                }""")
            page.wait_for_timeout(500)
        except Exception:
            pass
        # 长文/答案常懒加载：温和滚动几次并尽力展开“显示全部/阅读全文”（有界、失败不致命）。
        try:
            page.evaluate(
                """() => {
                    for (const el of document.querySelectorAll('button, [role=button], .Button')) {
                        const text = (el.textContent || '').trim();
                        if (text === '显示全部' || text === '展开阅读全文' || text === '阅读全文') el.click();
                    }
                }""")
            for _ in range(3):
                page.mouse.wheel(0, 1200)
                page.wait_for_timeout(700)
        except Exception:
            pass
        page.wait_for_timeout(800)
        rules = SITE_RULES.get(urllib.parse.urlsplit(url).hostname or '', {})
        data = page.evaluate(
            """(args) => {
                const rules = args.rules;
                const pickAll = (sel) => {
                    try { return sel ? [...document.querySelectorAll(sel)].map(el => el.innerText || '').join('\\n') : ''; }
                    catch { return ''; }
                };
                const pickOne = (sel) => {
                    try { return sel ? (document.querySelector(sel)?.innerText || '') : ''; }
                    catch { return ''; }
                };
                const main = document.querySelector('main') || document.querySelector('article') || document.body;
                const ruleText = pickAll(rules.text);
                // 命中站点规则时只用规则内容：拿到太少说明是空壳页，留空以继续降级。
                const text = rules.text
                    ? (ruleText.length >= args.minRule ? ruleText : '')
                    : ((main ? main.innerText : '') || ruleText);
                return {
                    title: (pickOne(rules.title) || document.title || '').trim(),
                    text,
                    url: location.href,
                };
            }""", {"rules": rules, "minRule": MIN_RULE_TEXT})
        text = _normalize_text(str(data.get('text') or ''))[:MAX_TEXT_CHARS]
        return {'title': str(data.get('title') or '')[:200], 'text': text,
                'chars': len(text), 'url': str(data.get('url') or url)}


def _plain(exc: Exception | None) -> str:
    if exc is None:
        return '未知错误'
    first = (str(exc).strip().splitlines() or [''])[0]
    return first[:200] or exc.__class__.__name__
