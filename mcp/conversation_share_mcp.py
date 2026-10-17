#!/usr/bin/env python3
"""对话分享 MCP 服务（stdio，JSON-RPC 逐行，零外部依赖）。

工具：share_conversation / read_conversation_share / append_to_shared_conversation / list_conversation_shares
资源：easel-share://<token>（只读完整分享）

与后端共用 `web/conversation_share.py` 的存储（`<EASEL_DATA_DIR or 项目根>/conversation-shares`）。
只读写分享目录：不触达会话库、网关、密钥或模型服务。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
if str(PROJECT_ROOT / 'web') not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / 'web'))

from easel.paths import data_root  # noqa: E402
from conversation_share import ConversationShareStore  # noqa: E402
from fastapi import HTTPException  # noqa: E402

PROTOCOL_VERSION = '2024-11-05'
SERVER_INFO = {'name': 'easel-conversation-share', 'version': '1.0.0'}
_STORE = None


def store() -> ConversationShareStore:
    global _STORE
    if _STORE is None:
        _STORE = ConversationShareStore(data_root(PROJECT_ROOT) / 'conversation-shares')
    return _STORE


MESSAGE_SCHEMA = {
    'type': 'array',
    'description': '完整消息列表（role: user/assistant/system，content 必填）',
    'items': {
        'type': 'object',
        'properties': {
            'role': {'type': 'string', 'enum': ['user', 'assistant', 'system']},
            'content': {'type': 'string'},
            'at': {'type': 'number'},
            'modelRef': {'type': 'string'},
            'turnId': {'type': 'string'},
        },
        'required': ['role', 'content'],
    },
}

TOOLS = [
    {
        'name': 'share_conversation',
        'description': '把一段完整对话发布为分享（本地存储，token 访问）。分享内容是全量消息快照，供外部模型接管使用。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'sessionId': {'type': 'string', 'description': '原对话标识'},
                'title': {'type': 'string'},
                'messages': MESSAGE_SCHEMA,
                'meta': {'type': 'object', 'properties': {'modelRef': {'type': 'string'}, 'engine': {'type': 'string'}}},
            },
            'required': ['sessionId', 'messages'],
        },
    },
    {
        'name': 'read_conversation_share',
        'description': '读取分享的完整内容与既有接管追加（接管前先读它拿到全部上下文）。',
        'inputSchema': {
            'type': 'object',
            'properties': {'token': {'type': 'string'}, 'afterIndex': {'type': 'integer', 'minimum': 0}},
            'required': ['token'],
        },
    },
    {
        'name': 'append_to_shared_conversation',
        'description': '把接管后生成的内容追加到分享上；Easel 客户端可在原对话里“加载回来”。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'token': {'type': 'string'},
                'messages': MESSAGE_SCHEMA,
                'source': {'type': 'object', 'properties': {'model': {'type': 'string'}, 'harness': {'type': 'string'}}},
                'note': {'type': 'string'},
            },
            'required': ['token', 'messages'],
        },
    },
    {
        'name': 'list_conversation_shares',
        'description': '列出本机已有分享与追加计数。',
        'inputSchema': {'type': 'object', 'properties': {'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100}}},
    },
]


def call_tool(name: str, arguments: dict) -> dict:
    service = store()
    arguments = arguments if isinstance(arguments, dict) else {}
    if name == 'share_conversation':
        return service.create(arguments)
    if name == 'read_conversation_share':
        return service.read(arguments.get('token', ''), int(arguments.get('afterIndex') or 0))
    if name == 'append_to_shared_conversation':
        return service.append(arguments.get('token', ''), arguments)
    if name == 'list_conversation_shares':
        return {'shares': service.list(int(arguments.get('limit') or 20))}
    raise HTTPException(404, f'未知工具：{name}')


def handle(message: dict):
    method = message.get('method')
    params = message.get('params') if isinstance(message.get('params'), dict) else {}
    if method == 'initialize':
        return {
            'protocolVersion': PROTOCOL_VERSION,
            'capabilities': {'tools': {'listChanged': False}, 'resources': {'subscribe': False, 'listChanged': False}},
            'serverInfo': SERVER_INFO,
        }
    if method in ('notifications/initialized', 'notifications/cancelled'):
        return None
    if method == 'ping':
        return {}
    if method == 'tools/list':
        return {'tools': TOOLS}
    if method == 'tools/call':
        result = call_tool(str(params.get('name') or ''), params.get('arguments') or {})
        return {'content': [{'type': 'text', 'text': json.dumps(result, ensure_ascii=False)}], 'isError': False}
    if method == 'resources/list':
        shares = store().list(100)
        return {'resources': [
            {'uri': f'easel-share://{item["token"]}', 'name': item['title'], 'mimeType': 'application/json',
             'description': f'{item["messageCount"]} 条消息 · {item["appendCount"]} 条接管追加'}
            for item in shares
        ]}
    if method == 'resources/read':
        uri = str(params.get('uri') or '')
        if not uri.startswith('easel-share://'):
            raise HTTPException(404, '不支持的资源地址')
        return {'contents': [{'uri': uri, 'mimeType': 'application/json',
                              'text': json.dumps(store().read(uri[len('easel-share://'):]), ensure_ascii=False)}]}
    raise HTTPException(404, f'未知方法：{method}')


def respond(payload, request_id):
    body = {'jsonrpc': '2.0', 'id': request_id, **payload}
    sys.stdout.write(json.dumps(body, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError('message must be an object')
            request_id = message.get('id')
            result = handle(message)
            if result is None:
                continue
            respond({'result': result}, request_id)
        except HTTPException as error:
            respond({'error': {'code': -32000, 'message': str(error.detail)}}, request_id if request_id is not None else 0)
        except (ValueError, TypeError) as error:
            respond({'error': {'code': -32700, 'message': f'请求解析失败：{error}'}}, request_id if request_id is not None else 0)
        except Exception as error:  # 不让单个请求打断服务
            respond({'error': {'code': -32603, 'message': f'内部错误：{error}'}}, request_id if request_id is not None else 0)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
