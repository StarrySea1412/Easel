"""Own-account identity from authenticated platform pages; fail closed on drift.

Only stable public account identifiers leave this module. Session tokens,
cookies and WeChat editor tickets are never returned or logged.
"""
from urllib.parse import urlsplit
import re


def public_id(value) -> str:
    value = str(value or '').strip()
    return value if re.fullmatch(r'[A-Za-z0-9_.:@-]{1,128}', value) else ''


def page_identity(platform, page) -> dict:
    if platform == 'xiaohongshu':
        import xhs_publish as runner
        page.goto(runner.EXPLORE_URL, wait_until='domcontentloaded')
        page.wait_for_selector(runner.SELECTORS['login_ok'], timeout=10000)
        link = page.query_selector('.main-container .user a[href^="/user/profile/"]')
        value = runner.own_account_id(link.get_attribute('href') if link else '', page.url)
        return {'externalAccountId': value, 'name': ''}
    if platform == 'douyin':
        import platform_readback as rb
        page.goto('https://creator.douyin.com/', wait_until='domcontentloaded')
        if urlsplit(page.url).hostname != 'creator.douyin.com':
            raise RuntimeError('Target account page unavailable')
        value = rb.read_douyin_account(page)
        return {'externalAccountId': public_id(value.get('platform_account_id')), 'name': value.get('display_name', '')}
    if platform == 'kuaishou':
        import platform_readback as rb
        # Restrict extraction to the authenticated self-info response, never
        # infer the owner from arbitrary works/authors in a content feed.
        responses = rb._capture_json_responses(page, rb.KUAISHOU_MANAGE_URL, ('home/userInfo',),
                                              wait_ms=15000, wait_urls_any=('home/userInfo',))
        responses = [row for row in responses if urlsplit(row.get('url', '')).hostname == 'cp.kuaishou.com'
                     and 'home/userInfo' in urlsplit(row.get('url', '')).path]
        rb._kuaishou_assert_logged_in(page)
        value = rb._find_kuaishou_identity(responses) or {}
        return {'externalAccountId': public_id(value.get('platform_account_id')), 'name': value.get('display_name', '')}
    if platform == 'zhihu':
        response = page.request.get('https://www.zhihu.com/api/v4/me', timeout=20000)
        if response.status != 200 or urlsplit(response.url).hostname != 'www.zhihu.com':
            raise RuntimeError('Authenticated identity unavailable')
        value = response.json()
        if value.get('error') or not value.get('id'):
            raise RuntimeError('Authenticated identity missing')
        return {'externalAccountId': public_id(value['id']), 'name': value.get('name', '')}
    if platform == 'weixin-channels':
        page.goto('https://channels.weixin.qq.com/platform', wait_until='domcontentloaded')
        page.wait_for_selector('.finder-uniq-id', timeout=10000)
        if urlsplit(page.url).hostname != 'channels.weixin.qq.com':
            raise RuntimeError('Target account page unavailable')
        element = page.query_selector('.finder-uniq-id')
        raw = element.inner_text().strip() if element and element.is_visible() else ''
        value = re.sub(r'^(?:唯一ID|视频号ID|视频号|ID)\s*[:：]?\s*', '', raw, flags=re.I)
        name = page.query_selector('.finder-nickname')
        return {'externalAccountId': public_id(value), 'name': name.inner_text().strip()[:80] if name else ''}
    if platform == 'wechat-oa':
        import weixin_mp_stats as runner
        page.goto(runner.MP_HOME, wait_until='domcontentloaded', timeout=60000)
        if urlsplit(page.url).hostname != 'mp.weixin.qq.com':
            raise RuntimeError('Target account page unavailable')
        token = runner._extract_token(page.url)
        if not token:
            raise RuntimeError('Authenticated session unavailable')
        value = runner._editor_ctx(page, token)
        return {'externalAccountId': public_id(value.get('user_name')), 'name': value.get('nick_name', '')}
    raise ValueError('Unsupported account platform')


def require_context(context, platform, expected):
    if not expected:
        return
    page = context.new_page()
    try:
        actual = page_identity(platform, page).get('externalAccountId')
        if not actual or actual != expected:
            raise RuntimeError('平台身份与确认稿不一致，内容未提交。')
    finally:
        page.close()


def require_bilibili(cookie, expected):
    if not expected:
        return
    import platform_readback as rb
    actual = public_id(rb.read_bilibili_account(cookie).get('uid'))
    if not actual or actual != expected:
        raise RuntimeError('B站身份与确认稿不一致，内容未提交。')
