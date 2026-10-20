import json

from easel.execution import begin, returned, codex_rows
from easel.execution_store import ExecutionStore, read
from easel.web_sources import references, safe_url


def test_structured_web_results_keep_titles_and_deduplicate_without_credentials():
    row = begin('s', 't', 'c', 'web_search', {'query': '资料检索'})
    returned(row, {'content': [{'type': 'text', 'text': json.dumps({'results': [
        {'url': 'https://example.org/guide#heading', 'title': '官方指南'},
        {'url': 'https://example.org/guide', 'title': '官方指南'},
        {'url': 'https://example.org/?token=private-value', 'title': '不应展示'},
        {'url': 'javascript:alert(1)'}, {'url': 'https://user:pass@example.org/'},
    ]})}], 'isError': False})
    assert row['webSources'] == [{'url': 'https://example.org/guide', 'title': '官方指南'}]
    assert 'private-value' not in json.dumps(row['webSources'])


def test_markdown_text_and_rich_mcp_resources_are_sources_but_shell_text_is_not():
    web = references('web_fetch', {'content': '[官方文档](https://example.org/docs)\nhttps://example.org/next.'}, lambda text: text if isinstance(text, str) else '')
    assert web == [{'url': 'https://example.org/docs', 'title': '官方文档'}, {'url': 'https://example.org/next', 'title': ''}]
    assert references('exec', {'content': 'made up https://unobserved.example/'}, str) == []
    result = {'content': [{'type': 'resource_link', 'uri': 'https://example.org/resource', 'name': '参考资料'}]}
    assert references('mcp_lookup', result, str) == [{'url': 'https://example.org/resource', 'title': '参考资料'}]


def test_failed_or_private_tool_does_not_publish_links_and_targets_are_preserved():
    row = begin('s', 't', 'c', 'web_fetch', {'url': 'https://example.org/blocked'})
    returned(row, {'isError': True, 'content': 'try https://unconfirmed.example/'})
    assert row['url'] == 'https://example.org/blocked' and row['status'] == 'failed'
    assert 'webSources' not in row
    row = begin('s', 't', 'p', 'read', {'path': '.env'})
    returned(row, {'content': [{'type': 'resource_link', 'uri': 'https://private.example/'}]})
    assert row['contentHidden'] and 'webSources' not in row


def test_live_web_receipts_survive_reopening_the_execution_journal(tmp_path):
    store = ExecutionStore(tmp_path, 'session', 'turn')
    store.consume({'stream': 'tool', 'data': {'phase': 'start', 'toolCallId': 'web', 'name': 'web_search', 'args': {'query': '资料'}}})
    store.consume({'stream': 'tool', 'data': {'phase': 'end', 'toolCallId': 'web', 'result': {'content': [{'type': 'text', 'text': '{"results":[{"url":"https://example.org/","title":"来源"}]}'}]}}})
    assert read(tmp_path, 'session', 'turn')[0]['webSources'][0]['title'] == '来源'
    assert read(tmp_path, 'other', 'turn') == []


def test_codex_native_search_and_mcp_references_preserve_actual_identity():
    rows = codex_rows({'sessionId': 's', 'turn_id': 't', 'items': [
        {'id': 'web', 'type': 'webSearch', 'status': 'completed', 'action': {'type': 'search', 'queries': ['资料', '官方文档']}},
        {'id': 'mcp', 'type': 'mcpToolCall', 'tool': 'lookup_docs', 'status': 'completed',
         'result': {'content': [{'type': 'resource_link', 'uri': 'https://example.org/', 'title': '官方原文'}]}},
    ]})
    assert rows[0]['query'] == '资料 · 官方文档' and 'webSources' not in rows[0]
    assert rows[1]['name'] == 'lookup_docs' and rows[1]['webSources'][0]['title'] == '官方原文'


def test_query_bearing_urls_and_parser_bounds():
    assert safe_url('https://example.org/search?q=文档')
    for value in ['file:///tmp/test', 'https://example.org/?api_key=hidden', 'https://example.org/?x-signature=hidden', 'https://example.org/ a']:
        assert safe_url(value) is None
    data = {'results': [{'url': f'https://example.org/{i}', 'title': '资料'} for i in range(300)]}
    assert len(references('web_search', data, lambda value: value if isinstance(value, str) else '')) == 100


def test_bound_browser_snapshot_links_are_retained_as_browser_evidence():
    row = begin('s', 't', 'browser', 'easel_browser', {'action': 'observe'})
    returned(row, {'content': json.dumps({'snapshot': {'url': 'https://example.org/page', 'title': '观察页面', 'text': '普通正文'}})})
    assert row['kind'] == 'browser'
    assert row['webSources'] == [{'url': 'https://example.org/page', 'title': '观察页面'}]
