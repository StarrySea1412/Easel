"""对话分享存储：完整快照、追加回传与校验；全部在临时目录，不触达真实数据。"""
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import conversation_share


@pytest.fixture()
def store(tmp_path):
    return conversation_share.ConversationShareStore(tmp_path / 'conversation-shares')


def sample(messages=None):
    return {
        'sessionId': 'session-1', 'title': '拆解对话',
        'meta': {'modelRef': 'relay/glm-5.3', 'engine': 'openclaw'},
        'messages': messages if messages is not None else [
            {'role': 'user', 'content': '帮我拆解这篇', 'at': 1},
            {'role': 'assistant', 'content': '好的，报告如下', 'modelRef': 'relay/glm-5.3'},
        ],
    }


def test_share_round_trip_keeps_the_complete_transcript_and_survives_reload(store):
    created = store.create(sample())
    assert created['messageCount'] == 2
    assert len(created['token']) >= 20
    read = store.read(created['token'])
    assert [m['role'] for m in read['messages']] == ['user', 'assistant']
    assert read['meta']['modelRef'] == 'relay/glm-5.3'
    reloaded = conversation_share.ConversationShareStore(store.root)  # 重新打开目录＝重启后仍可读
    assert reloaded.read(created['token'])['title'] == '拆解对话'


def test_takeover_appends_are_recorded_with_source_and_listed_back(store):
    token = store.create(sample())['token']
    first = store.append(token, {'messages': [{'role': 'assistant', 'content': '接管产出 1'}],
                                 'source': {'model': 'claude-sonnet', 'harness': 'Claude Desktop'}, 'note': '继续写'})
    store.append(token, {'messages': [{'role': 'assistant', 'content': '接管产出 2'}]})
    read = store.read(token)
    assert read['appendCount'] == 2
    assert read['appends'][0]['appendId'] == first['appendId']
    assert read['appends'][0]['source']['harness'] == 'Claude Desktop'
    assert read['appends'][-1]['messages'][0]['content'] == '接管产出 2'
    assert store.read(token, after_index=1)['appends'][0]['messages'][0]['content'] == '接管产出 2'
    listed = store.list()
    assert listed[0]['token'] == token and listed[0]['appendCount'] == 2


@pytest.mark.parametrize('payload,status', [
    ({**sample(messages=[])}, 400),
    ({**sample(), 'sessionId': '  '}, 400),
    ({**sample(), 'messages': [{'role': 'robot', 'content': 'x'}]}, 400),
])
def test_invalid_shares_are_rejected_without_writing(store, payload, status):
    with pytest.raises(HTTPException) as error:
        store.create(payload)
    assert error.value.status_code == status
    assert not store.root.exists() or not list(store.root.glob('*.json'))


def test_unknown_tokens_and_empty_appends_fail_closed(store):
    with pytest.raises(HTTPException) as error:
        store.read('../escape')
    assert error.value.status_code == 400
    with pytest.raises(HTTPException) as error:
        store.read('A' * 32)
    assert error.value.status_code == 404
    token = store.create(sample())['token']
    with pytest.raises(HTTPException) as error:
        store.append(token, {'messages': []})
    assert error.value.status_code == 400


def test_control_characters_are_stripped_from_shared_text(store):
    token = store.create(sample(messages=[{'role': 'user', 'content': 'a\u0000b\x1bc'}], ))['token']
    assert store.read(token)['messages'][0]['content'] == 'abc'


def test_main_app_mounts_the_share_routes():
    paths = set(web.app.openapi()['paths'])
    assert {'/api/conversation-shares', '/api/conversation-shares/{token}',
            '/api/conversation-shares/{token}/appends'} <= paths
