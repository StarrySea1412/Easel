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


def test_reader_falls_back_to_browser_when_http_is_blocked():
    calls = []

    def http(url):
        calls.append(('http', url))
        raise urllib.error.HTTPError(url, 403, 'Forbidden', None, None)

    def browser(url):
        calls.append(('browser', url))
        return {'title': '问题标题', 'text': '正文' * 220, 'chars': 440, 'url': url}

    reader = link_reader.LinkReader(http_fetch=http, browser_fetch=browser)
    result = reader.read('https://www.zhihu.com/question/1')
    assert result['ok'] and result['source'] == 'browser' and result['title'] == '问题标题'
    assert calls == [('http', 'https://www.zhihu.com/question/1'),
                     ('browser', 'https://www.zhihu.com/question/1')]


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
    result = reader.read('https://www.zhihu.com/question/1')
    assert not result['ok'] and result['source'] is None
    assert '浏览器启动失败' in result['reason'] and 'HTTP 403' in result['reason']
    assert '粘贴进来再试' in result['reason'], '失败时给出可操作替代'
    blocked = reader.read('http://127.0.0.1/x')
    assert not blocked['ok'] and '不允许' in blocked['reason']
    assert not reader.read('x')['ok']


def test_reader_bounds_text_length():
    reader = link_reader.LinkReader(
        http_fetch=lambda url: {'title': 't', 'text': 'w' * 100_000, 'chars': 100_000, 'url': url},
        browser_fetch=lambda url: {'title': '', 'text': '', 'chars': 0, 'url': url})
    result = reader.read('https://example.com/long')
    assert result['ok'] and result['chars'] == link_reader.MAX_TEXT_CHARS

