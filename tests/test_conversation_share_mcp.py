"""对话分享 MCP：以真实 stdio 子进程驱动协议，数据落在临时目录。"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / 'mcp' / 'conversation_share_mcp.py'


def run_session(lines, data_dir):
    env = {**os.environ, 'EASEL_DATA_DIR': str(data_dir), 'PYTHONIOENCODING': 'utf-8'}
    proc = subprocess.run([sys.executable, str(SERVER)], input='\n'.join(json.dumps(line) for line in lines) + '\n',
                          capture_output=True, text=True, encoding='utf-8', env=env, timeout=60)
    assert proc.returncode == 0, proc.stderr
    replies = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    return {reply.get('id'): reply for reply in replies}


def test_share_takeover_load_back_full_loop_over_stdio(tmp_path):
    messages = [{'role': 'user', 'content': '拆解这篇爆款'}, {'role': 'assistant', 'content': '初版报告'}]
    replies = run_session([
        {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05'}},
        {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
        {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
        {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'share_conversation',
            'arguments': {'sessionId': 's1', 'title': '拆解对话', 'messages': messages}}},
    ], tmp_path)
    assert replies[1]['result']['serverInfo']['name'] == 'easel-conversation-share'
    tools = {tool['name'] for tool in replies[2]['result']['tools']}
    assert {'share_conversation', 'read_conversation_share', 'append_to_shared_conversation', 'list_conversation_shares'} <= tools
    created = json.loads(replies[3]['result']['content'][0]['text'])
    token = created['token']
    assert created['messageCount'] == 2

    # 第二个会话扮演接管方：读完整分享 → 追加生成内容 → 资源列表可见
    replies = run_session([
        {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}},
        {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'read_conversation_share', 'arguments': {'token': token}}},
        {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'append_to_shared_conversation', 'arguments': {
            'token': token, 'messages': [{'role': 'assistant', 'content': '接管后的完整报告'}],
            'source': {'model': 'glm-5.3', 'harness': 'ZCode'}, 'note': '接管续写'}}},
        {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'read_conversation_share', 'arguments': {'token': token}}},
        {'jsonrpc': '2.0', 'id': 5, 'method': 'resources/list'},
        {'jsonrpc': '2.0', 'id': 6, 'method': 'resources/read', 'params': {'uri': f'easel-share://{token}'}},
    ], tmp_path)
    assert [m['content'] for m in json.loads(replies[2]['result']['content'][0]['text'])['messages']] == ['拆解这篇爆款', '初版报告']
    appended = json.loads(replies[3]['result']['content'][0]['text'])
    assert appended['total'] == 1 and appended['appendId']
    loaded = json.loads(replies[4]['result']['content'][0]['text'])
    assert loaded['appends'][0]['messages'][0]['content'] == '接管后的完整报告'
    assert loaded['appends'][0]['source']['harness'] == 'ZCode'
    resource = replies[5]['result']['resources'][0]
    assert resource['uri'] == f'easel-share://{token}' and '1 条接管追加' in resource['description']
    assert json.loads(replies[6]['result']['contents'][0]['text'])['title'] == '拆解对话'


def test_unknown_tool_and_missing_token_report_structured_errors(tmp_path):
    replies = run_session([
        {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}},
        {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'not_a_tool', 'arguments': {}}},
        {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'read_conversation_share', 'arguments': {'token': 'A' * 32}}},
        {'jsonrpc': '2.0', 'id': 4, 'method': 'nonsense/method'},
    ], tmp_path)
    assert '未知工具' in replies[2]['error']['message']
    assert '分享不存在' in replies[3]['error']['message']
    assert '未知方法' in replies[4]['error']['message']
