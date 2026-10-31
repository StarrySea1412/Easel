import asyncio

import pytest

import web.app as web
from easel.gateway_auth import GatewayCredentials
from easel.gateway_questions import GatewayQuestionError


@pytest.mark.parametrize(("credentials", "expected"), [
    (GatewayCredentials("token", token="synthetic-token"), {"token": "synthetic-token"}),
    (GatewayCredentials("password", password="synthetic-password"), {"password": "synthetic-password"}),
    (GatewayCredentials("none"), {"token": ""}),
    (GatewayCredentials(""), None),
])
def test_question_gateway_client_uses_only_configured_auth(monkeypatch, credentials, expected):
    calls = []

    class Client:
        def __init__(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(web, "GatewayClient", Client)
    web._question_gateway_client(credentials)

    assert calls == ([{"auth": expected}] if expected is not None else [{}])


@pytest.mark.parametrize("credentials", [
    GatewayCredentials("token"),
    GatewayCredentials("password"),
    GatewayCredentials("trusted-proxy"),
])
def test_question_gateway_client_never_falls_back_from_explicit_auth(monkeypatch, credentials):
    monkeypatch.setattr(web, "GatewayClient", lambda **_: pytest.fail("must not use paired-device fallback"))

    with pytest.raises(GatewayQuestionError):
        web._question_gateway_client(credentials)


def test_question_answer_and_replay_status_share_explicit_gateway_auth(monkeypatch):
    auths = []

    class Client:
        def __init__(self, **kwargs):
            auths.append(kwargs.get("auth"))

        def connect(self):
            pass

        def resolve(self, question_id, answers, resolved_by):
            return {"id": question_id, "answers": answers, "resolvedBy": resolved_by}

        def get_question(self, question_id):
            return {"id": question_id, "status": "pending"}

        def close(self):
            pass

    monkeypatch.setattr(web, "GatewayClient", Client)
    monkeypatch.setattr(web, "gateway_credentials", lambda: GatewayCredentials("token", token="synthetic-token"))
    monkeypatch.setattr(web, "_direct_api_enabled", lambda: False)
    monkeypatch.setattr(web, "_harness_settings", lambda: {"runtime": "openclaw"})

    async def exercise():
        answered = await web.api_question_answer(web.QuestionAnswerRequest(
            questionId="openclaw-question", answers={"choice": ["A"]}))
        status = await web.api_question_status(web.QuestionStatusRequest(
            questionIds=["openclaw-question"]))
        return answered, status

    answered, status = asyncio.run(exercise())

    assert answered["ok"] is True
    assert status["questions"]["openclaw-question"]["status"] == "pending"
    assert auths == [{"token": "synthetic-token"}, {"token": "synthetic-token"}]


@pytest.mark.parametrize(("error_code", "expected"), [
    ("QUESTION_NOT_FOUND", "not_found"),
    ("INTERNAL", "unknown"),
    (None, "unknown"),
])
def test_question_status_only_treats_explicit_not_found_as_terminal(monkeypatch, error_code, expected):
    class Client:
        def connect(self):
            pass

        def get_question(self, question_id):
            error = GatewayQuestionError("gateway lookup failed")
            error.error_code = error_code
            raise error

        def close(self):
            pass

    monkeypatch.setattr(web, "GatewayClient", lambda **_: Client())
    monkeypatch.setattr(web, "gateway_credentials", lambda: GatewayCredentials("none"))
    monkeypatch.setattr(web, "_direct_api_enabled", lambda: False)
    monkeypatch.setattr(web, "_harness_settings", lambda: {"runtime": "openclaw"})

    result = asyncio.run(web.api_question_status(web.QuestionStatusRequest(
        questionIds=["openclaw-question"])))

    assert result["questions"]["openclaw-question"]["status"] == expected
