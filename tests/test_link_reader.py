"""受控链接读取：URL 校验、HTML 提取、HTTP→有头浏览器回退与如实失败。"""
import urllib.error

import pytest

from web import link_reader


def test_validate_url_blocks_private_and_non_http():
    assert link_reader.validate_url('https://www.zhihu.com/question/1') == 'https://www.zhihu.com/question/1'
    for bad in ('ftp://example.com/x', 'file:///etc/passwd', '', 'javascript:alert(1)',
                'http://localhost/x', 'http://127.0.0.1/x', 'http://192.168.1.5/x',
                'http://10.0.0.8/x', 'http://[::1]/x', 'http://foo.local/x'):
        with pytest.raises(link_reader.LinkError):
            link_reader.validate_url(bad)


def test_extract_html_keeps_title_and_blocks_without_scripts():
    html = ('<html><head><title>标题甲</title><script>var secret = 1;</script>'
            '<style>.a{color:red}</style></head><body><h1>正文标题</h1>'
            '<p>第一段。</p><p>第二段。</p></body></html>')
    out = link_reader.extract_html(html)
    assert out['title'] == '标题甲'
    assert '第一段。' in out['text'] and '第二段。' in out['text'] and '正文标题' in out['text']
    assert 'var secret' not in out['text'] and 'color:red' not in out['text']
    assert '\n' in out['text'], '块级标签产生换行'


def test_extract_html_prefers_semantic_content_over_navigation():
    body = '页面事实与证据。' * 60
    html = (f'<title>页面</title><nav>{"站点导航" * 500}</nav><main><h1>正文标题</h1>'
            f'<aside>推荐广告</aside><article><p>{body}</p></article>'
            '<nav>章节导航</nav><script>hidden()</script><footer>页尾链接</footer></main>')
    out = link_reader.extract_html(html)
    assert out['title'] == '页面'
    assert '正文标题' in out['text'] and body in out['text']
    for chrome in ('站点导航', '推荐广告', '章节导航', 'hidden()', '页尾链接'):
        assert chrome not in out['text']


def test_extract_html_short_semantic_shell_keeps_body_fallback():
    body = '没有语义容器的有效正文。' * 50
    out = link_reader.extract_html(f'<main>加载中</main><section>{body}</section>')
    assert body in out['text']


def test_extract_html_role_main_and_void_elements_preserve_content():
    body = '分析材料。' * 100
    out = link_reader.extract_html(f'<div role="main"><h1>标题</h1><img src="x"><br/>'
                                   f'<p>{body}</p><input value="x"></div><p>正文外的链接</p>')
    assert '标题' in out['text'] and body in out['text']
    assert '正文外的链接' not in out['text']


def test_reader_falls_back_to_browser_when_http_is_blocked():
    calls = []

    def http(url):
        calls.append(('http', url))
        raise urllib.error.HTTPError(url, 403, 'Forbidden', None, None)

    def browser(url):
        calls.append(('browser', url))
        return {'title': '问题标题', 'text': '正文' * 220, 'chars': 440, 'url': url}

    reader = link_reader.LinkReader(http_fetch=http, browser_fetch=browser)
    result = reader.read('https://example.com/question/1')
    assert result['ok'] and result['source'] == 'browser' and result['title'] == '问题标题'
    assert calls == [('http', 'https://example.com/question/1'),
                     ('browser', 'https://example.com/question/1')]


def test_rule_hosts_skip_http_and_use_the_browser_ladder():
    calls = []

    def http(_url):
        calls.append('http')
        raise AssertionError('有站点规则的域名不应走普通 HTTP')

    def browser(url):
        calls.append('browser')
        return {'title': '问题', 'text': '正文' * 400, 'chars': 800, 'url': url}

    reader = link_reader.LinkReader(http_fetch=http, browser_fetch=browser)
    result = reader.read('https://www.zhihu.com/question/1')
    assert result['ok'] and result['source'] == 'browser' and calls == ['browser']


def test_redirect_guard_errors_stop_before_the_browser():
    def http(_url):
        raise link_reader.LinkError('重定向目标不允许读取')

    def browser(_url):
        raise AssertionError('私有地址拦截后不应启动浏览器')

    reader = link_reader.LinkReader(http_fetch=http, browser_fetch=browser)
    result = reader.read('https://example.com/r')
    assert not result['ok'] and '重定向' in result['reason']


def test_reader_prefers_http_and_treats_short_pages_as_blocked():
    def short_http(url):
        return {'title': 't', 'text': 'x' * 10, 'chars': 10, 'url': url}

    reader = link_reader.LinkReader(http_fetch=short_http,
                                    browser_fetch=lambda url: {'title': 'b', 'text': 'y' * 500, 'chars': 500, 'url': url})
    assert reader.read('https://example.com/a')['source'] == 'browser'

    def explode(_url):
        raise AssertionError('HTTP 已读到足量正文时不应调用浏览器')

    good = link_reader.LinkReader(http_fetch=lambda url: {'title': 't', 'text': 'z' * 500, 'chars': 500, 'url': url},
                                  browser_fetch=explode)
    result = good.read('https://example.com/a')
    assert result['ok'] and result['source'] == 'http' and result['chars'] == 500


def test_reader_reports_honest_failure_and_bad_urls():
    def broken(_url):
        raise RuntimeError('浏览器启动失败')

    reader = link_reader.LinkReader(
        http_fetch=lambda _url: (_ for _ in ()).throw(RuntimeError('HTTP 403 Forbidden')),
        browser_fetch=broken)
    result = reader.read('https://example.com/question/1')
    assert not result['ok'] and result['source'] is None
    assert '浏览器启动失败' in result['reason'] and 'HTTP 403' in result['reason']
    assert '粘贴进来再试' in result['reason'], '失败时给出可操作替代'
    blocked = reader.read('http://127.0.0.1/x')
    assert not blocked['ok'] and '不允许' in blocked['reason']
    assert not reader.read('x')['ok']


def test_shell_pages_below_the_read_threshold_are_not_results():
    reader = link_reader.LinkReader(
        http_fetch=lambda url: {'title': 't', 'text': 'x' * 50, 'chars': 50, 'url': url},
        browser_fetch=lambda url: {'title': 'shell', 'text': 'x' * 50, 'chars': 50, 'url': url})
    result = reader.read('https://example.com/a')
    assert not result['ok'], '两级都低于接受门槛时按失败处理，不把空壳当正文'
    assert '粘贴进来再试' in (result['reason'] or '')


def test_reader_bounds_text_length():
    reader = link_reader.LinkReader(
        http_fetch=lambda url: {'title': 't', 'text': 'w' * 100_000, 'chars': 100_000, 'url': url},
        browser_fetch=lambda url: {'title': '', 'text': '', 'chars': 0, 'url': url})
    result = reader.read('https://example.com/long')
    assert result['ok'] and result['chars'] == link_reader.MAX_TEXT_CHARS


def test_profile_mapping_prefers_the_built_in_logged_in_profiles(tmp_path):
    (tmp_path / 'ZhihuProfile').mkdir()
    (tmp_path / 'XiaohongshuProfile').mkdir()
    assert link_reader.profile_for_url('https://www.zhihu.com/question/1', root=tmp_path).name == 'ZhihuProfile'
    assert link_reader.profile_for_url('https://zhuanlan.zhihu.com/p/1', root=tmp_path).name == 'ZhihuProfile'
    assert link_reader.profile_for_url('https://www.xiaohongshu.com/explore/x', root=tmp_path).name == 'XiaohongshuProfile'
    assert link_reader.profile_for_url('https://www.douyin.com/video/1', root=tmp_path) is None, '缺失的登录配置目录回退匿名通道'
    assert link_reader.profile_for_url('https://www.bilibili.com/video/BV1', root=tmp_path) is None, '未映射的站点没有内置配置'

