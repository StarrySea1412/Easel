"""Isolated question discovery, SSE payload, and answer resolution flow."""
import asyncio
import json

import web.app as web
from easel.execution_store import ExecutionStore, read_snapshot
from easel.gateway_auth import GatewayCredentials


def test_question_list_is_published_once_and_answer_uses_configured_gateway(monkeypatch, tmp_path):
    execution_store = ExecutionStore(tmp_path, "session", "turn")
    execution_store.ingest([{
        "id": "ask-call", "name": "ask_user", "kind": "tool", "status": "running",
        "command": "", "path": "", "cwd": "", "output": "", "diff": "",
        "truncated": {}, "source": "transcript",
    }])
    question = {
        "id": "question-1",
        "questions": [{"questionId": "destination", "question": "选择平台？",
                        "options": [{"label": "小红书"}, {"label": "抖音"}]}],
        "expiresAtMs": 123456,
    }
    pushed = set()
    emitted = []
    execution_events = []
    proc = type("Proc", (), {"_pending_question": False})()
    emit = lambda kind, data: emitted.append((kind, data))

    waiting = web._publish_pending_questions(
        [question, {"id": "invalid", "questions": []}], pushed,
        execution_store=execution_store,
        proc=proc,
        emit=emit,
        publish_execution=execution_events.append,
    )
    web._publish_pending_questions(
        [question], pushed,
        execution_store=execution_store,
        proc=proc,
        emit=emit,
        publish_execution=execution_events.append,
    )

    assert waiting is True
    assert proc._pending_question is True
    assert len(emitted) == 1
    assert emitted[0][0] == "question"
    assert json.loads(emitted[0][1]) == question
    assert execution_events[0]["operations"][0]["waitingForUser"] is True
    assert read_snapshot(tmp_path, "session", "turn")["operations"][0]["waitingForUser"] is True

    auths = []
    resolutions = []

    class Client:
        def __init__(self, **kwargs):
            auths.append(kwargs.get("auth"))

        def connect(self):
            pass

        def resolve(self, question_id, answers, resolved_by):
            resolutions.append((question_id, answers, resolved_by))
            return {"id": question_id, "status": "answered"}

        def close(self):
            pass

    monkeypatch.setattr(web, "GatewayClient", Client)
    monkeypatch.setattr(web, "gateway_credentials", lambda: GatewayCredentials("token", token="synthetic-token"))
    monkeypatch.setattr(web, "_direct_api_enabled", lambda: False)
    monkeypatch.setattr(web, "_harness_settings", lambda: {"runtime": "openclaw"})

    answer = asyncio.run(web.api_question_answer(web.QuestionAnswerRequest(
        questionId="question-1", answers={"destination": ["小红书"]})))

    assert answer["ok"] is True
    assert resolutions == [("question-1", {"destination": ["小红书"]}, None)]
    assert auths == [{"token": "synthetic-token"}]
