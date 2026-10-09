"""Visible provider reasoning: mapping, account isolation, streaming and recovery."""
import asyncio
import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from easel.reasoning_stream import ReasoningStream, ThinkingTextStream, provider_reasoning
import app as web
import skill_audit


@pytest.mark.parametrize('field', ['reasoning_content', 'reasoning', 'reasoning_summary', 'thinking'])
def test_chat_provider_visible_reasoning_fields(field):
    assert provider_reasoning({'choices': [{'delta': {field: '公开摘要'}}]})[0][0] == '公开摘要'


def test_responses_summary_stream_done_and_replay_are_not_duplicated():
    stream = ReasoningStream()
    chunks = []
    for event in [
        {'type': 'response.reasoning_summary_text.delta', 'item_id': 'r1', 'sequence_number': 1, 'delta': '正在核对'},
        {'type': 'response.reasoning_summary_text.delta', 'item_id': 'r1', 'sequence_number': 1, 'delta': '正在核对'},
        {'type': 'response.reasoning_summary_text.done', 'item_id': 'r1', 'sequence_number': 2, 'text': '正在核对证据'},
    ]:
        for text, snapshot, block, ident in provider_reasoning(event):
            chunks.append(stream.push('http', text, snapshot=snapshot, block=block, event_id=ident))
    assert ''.join(chunks) == '正在核对证据'


def test_opaque_reasoning_is_not_rendered():
    assert provider_reasoning({'choices': [{'delta': {'reasoning': {'encrypted_content': 'secret'}}}]}) == []
    assert provider_reasoning({'choices': [{'delta': {'reasoning': [{'type': 'redacted_thinking', 'data': 'opaque'}]}}]}) == []
    assert provider_reasoning({'type': 'content_block_delta', 'delta': {'type': 'signature_delta', 'signature': 'opaque'}}) == []


@pytest.mark.parametrize('chunks', [list('<think>公开摘要</think>答案'), ['<thi', 'nk>公开', '摘要</th', 'ink>答案'], ['<thinking>公开摘要</thinking>答案']])
def test_newapi_thinking_wrapper_survives_fragmented_sse(chunks):
    stream = ThinkingTextStream()
    result = [stream.push(chunk) for chunk in chunks] + [stream.push('', final=True)]
    assert ''.join(pair[0] for pair in result) == '公开摘要'
    assert ''.join(pair[1] for pair in result) == '答案'


@pytest.mark.parametrize('text', ['示例：<think>这只是引用</think>', '```html\n<think>x</think>\n```', '<thi'])
def test_normal_answer_and_incomplete_tag_are_not_hidden(text):
    stream = ThinkingTextStream()
    result = [stream.push(text), stream.push('', final=True)]
    assert ''.join(pair[0] for pair in result) == ''
    assert ''.join(pair[1] for pair in result) == text


def test_anthropic_and_structured_summary_text():
    assert provider_reasoning({'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'thinking_delta', 'thinking': '可见文字'}})[0][0] == '可见文字'
    assert provider_reasoning({'choices': [{'delta': {'reasoning_summary': [{'type': 'summary_text', 'text': '摘要'}]}}]})[0][0] == '摘要'


def test_raw_end_snapshot_completes_missing_tail_and_sources_never_mix():
    stream = ReasoningStream()
    assert stream.push('raw', '已有') == '已有'
    assert stream.push('http', '已有内容') == ''
    assert stream.push('raw', '已有内容', snapshot=True) == '内容'
    assert stream.push('raw', '已有内容', snapshot=True) == ''
    stream.reset('raw')
    assert stream.push('raw', '工具后的下一段', snapshot=True) == '工具后的下一段'


def test_shared_stream_cannot_latch_foreign_session_or_missing_identity():
    foreign = json.dumps({'runId': 'foreign', 'sessionId': 'other', 'delta': '不属于当前会话'})
    assert web._raw_event_for_run(foreign, None, 'ours') is None
    assert web._raw_event_for_run(json.dumps({'runId': 'a'}), None, 'ours') is None
    own = json.dumps({'runId': 'a', 'sessionId': 'ours', 'delta': '本轮'})
    assert web._raw_event_for_run(own, None, 'ours')['runId'] == 'a'
    assert web._raw_event_for_run(own, 'b', 'ours') is None
    assert web._raw_event_for_run(json.dumps({'sessionId': 'ours'}), 'a', 'ours') is None


def test_actual_cli_supervisor_retains_thinking_and_job_replay(tmp_path, monkeypatch):
    session = 'reasoning-test'
    runtime_session = web._openclaw_session_id(session)
    raw_path = tmp_path / 'raw.jsonl'
    raw_path.write_text('', encoding='utf-8')
    class Process:
        def __init__(self, *args, **kwargs):
            self.stdout = io.StringIO('')
            records = [
                {'runId': 'foreign', 'sessionId': 'not-ours', 'event': 'assistant_thinking_stream', 'evtType': 'thinking_delta', 'delta': 'PRIVATE_FOREIGN'},
                {'runId': 'own', 'sessionId': runtime_session, 'event': 'assistant_thinking_stream', 'evtType': 'thinking_start'},
                {'runId': 'own', 'sessionId': runtime_session, 'event': 'assistant_thinking_stream', 'evtType': 'thinking_delta', 'delta': '实际返回的'},
                {'runId': 'own', 'sessionId': runtime_session, 'event': 'assistant_thinking_stream', 'evtType': 'thinking_end', 'content': '实际返回的公开摘要'},
                {'runId': 'own', 'sessionId': runtime_session, 'event': 'assistant_text_stream', 'evtType': 'text_delta', 'delta': '最后的回答。'},
                {'runId': 'own', 'sessionId': runtime_session, 'event': 'assistant_message_end'},
            ]
            with raw_path.open('a', encoding='utf-8') as f:
                for record in records:
                    f.write(json.dumps(record, ensure_ascii=False) + '\n')
        def poll(self): return 0

    class CrossLock:
        def __init__(self, key): pass
        def acquire(self, timeout): return True
        def release(self): pass

    monkeypatch.setattr(web, 'SESSIONS_DIR', tmp_path / 'sessions')
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'outputs')
    monkeypatch.setattr(web, 'DEBUG_DIR', tmp_path / 'debug')
    monkeypatch.setattr(web, 'SHARED_RAW_STREAM', raw_path)
    monkeypatch.setattr(web, '_CrossProcLock', CrossLock)
    monkeypatch.setattr(web, '_chat_message', lambda req: req.message)
    monkeypatch.setattr(web, '_selected_skill_specs', lambda req: {})
    monkeypatch.setattr(web, '_heal_openclaw_session', lambda key: None)
    monkeypatch.setattr(web, '_resolve_transport', lambda key: 'cli')
    monkeypatch.setattr(web, 'openclaw_base_cmd', lambda: ['fake-cli'])
    monkeypatch.setattr(web, '_proxy_env', lambda: {})
    monkeypatch.setattr(web, 'question_bridge_supported', None)
    monkeypatch.setattr(web, 'GatewayClient', None)
    monkeypatch.setattr(web, '_notify_email_web_turn', None)
    monkeypatch.setattr(web.subprocess, 'Popen', Process)
    monkeypatch.setattr(skill_audit, 'begin', lambda *args: None)

    async def scenario():
        monkeypatch.setattr(web, '_session_lock', lambda key: asyncio.Lock())
        response = await web.api_chat_stream(web.ChatRequest(message='隔离测试', sessionId=session, turnId='reasoning-turn'))
        async def collect():
            return [event async for event in response.body_iterator]
        events = await asyncio.wait_for(collect(), 5)
        thinking = ''.join(json.loads(e['data']) for e in events if e['event'] == 'thinking')
        assert thinking == '实际返回的公开摘要'
        result = await web.api_chat_last(session, 'reasoning-turn')
        assert result['status'] == 'done'
        assert result['thinking'] == thinking
        assert result['thinkingStatus'] == 'available'
        assert result['text'] == '最后的回答。'
        replay = web._read_job_events('reasoning-turn')
        assert ''.join(e['data'] for e in replay if e['event'] == 'thinking') == thinking
        assert replay[-1]['event'] == 'done'
        assert 'PRIVATE_FOREIGN' not in json.dumps(replay)
        assert (await web.api_chat_last('different-session'))['status'] == 'none'
    asyncio.run(scenario())


@pytest.mark.parametrize('mode', ['http', 'raw_end', 'raw_thinking_only', 'unavailable'])
def test_http_supervisor_waits_for_raw_tail_and_retains_provider_summary(tmp_path, monkeypatch, mode):
    import httpx
    raw = tmp_path / 'raw.jsonl'
    raw.write_text('', encoding='utf-8')
    class Response:
        status_code = 200
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def aiter_lines(self):
            yield 'data: ' + json.dumps({'id': 'chatcmpl_ours', 'choices': [{'delta': {'role': 'assistant'}}]})
            if mode == 'http':
                yield 'data: ' + json.dumps({'choices': [{'delta': {'reasoning_summary': '供应商公开摘要'}}]})
            # A real gateway can persist its final raw event only near the end
            # of the HTTP stream. The supervisor must wait for BOTH producers.
            if mode != 'unavailable':
                raw.write_text(json.dumps({'runId': 'chatcmpl_ours', 'event': 'assistant_thinking_stream',
                                            'evtType': 'thinking_end', 'content': '供应商公开摘要'}) + '\n' +
                               (json.dumps({'runId': 'chatcmpl_ours', 'event': 'assistant_message_end'}) + '\n' if mode != 'raw_thinking_only' else ''), encoding='utf-8')
            yield 'data: ' + json.dumps({'choices': [{'delta': {'content': '回答'}}]})
            yield 'data: [DONE]'
    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def stream(self, *args, **kwargs): return Response()
    class CrossLock:
        def __init__(self, key): pass
        def acquire(self, timeout): return True
        def release(self): pass
    monkeypatch.setattr(httpx, 'AsyncClient', Client)
    monkeypatch.setattr(web, 'SESSIONS_DIR', tmp_path / 'sessions')
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'outputs')
    monkeypatch.setattr(web, 'DEBUG_DIR', tmp_path / 'debug')
    monkeypatch.setattr(web, 'SHARED_RAW_STREAM', raw)
    monkeypatch.setattr(web, '_CrossProcLock', CrossLock)
    monkeypatch.setattr(web, '_chat_message', lambda req: req.message)
    monkeypatch.setattr(web, '_selected_skill_specs', lambda req: {})
    monkeypatch.setattr(web, '_heal_openclaw_session', lambda key: None)
    monkeypatch.setattr(web, '_resolve_transport', lambda key: 'http')
    monkeypatch.setattr(web, '_pin_transport', lambda *args: None)
    monkeypatch.setattr(web, 'openclaw_base_cmd', lambda: ['fake-cli'])
    monkeypatch.setattr(web, '_proxy_env', lambda: {})
    monkeypatch.setattr(web, 'question_bridge_supported', None)
    monkeypatch.setattr(web, 'GatewayClient', None)
    monkeypatch.setattr(web, '_notify_email_web_turn', None)
    monkeypatch.setattr(skill_audit, 'begin', lambda *args: None)
    async def scenario():
        monkeypatch.setattr(web, '_session_lock', lambda key: asyncio.Lock())
        response = await web.api_chat_stream(web.ChatRequest(message='模拟协议测试', sessionId='http-reasoning', turnId='http-turn'))
        async def collect(): return [event async for event in response.body_iterator]
        events = await asyncio.wait_for(collect(), 5)
        thinking = ''.join(json.loads(e['data']) for e in events if e['event'] == 'thinking')
        assert thinking == ('' if mode == 'unavailable' else '供应商公开摘要')
        result = await web.api_chat_last('http-reasoning', 'http-turn')
        assert result['thinking'] == thinking
        assert result['thinkingStatus'] == ('unavailable' if mode == 'unavailable' else 'available')
        assert result['text'] == '回答'
        assert events[-1]['event'] == 'done'
    asyncio.run(scenario())
