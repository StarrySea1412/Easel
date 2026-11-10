"""Question UI deadlines must match the backend wait and never imply approval."""
import asyncio
import json
import time

import pytest
import web.app as web


def test_harness_question_emits_deadline_and_rejects_late_answer(monkeypatch):
    async def exercise():
        events = []
        monkeypatch.setattr(web, 'TIMEOUT_CHAT', 60)
        before = time.time() * 1000
        task = asyncio.create_task(web._harness_ask('isolated-question', [
            {'questionId': 'permission', 'question': 'Continue?'}
        ], lambda kind, text: events.append((kind, json.loads(text)))))
        await asyncio.sleep(0)
        question = events[0][1]
        assert before + 59000 <= question['expiresAtMs'] <= time.time() * 1000 + 60000
        record = web._HARNESS_QUESTIONS[question['id']]
        assert record['expiresAtMs'] == question['expiresAtMs']
        record['expiresAtMs'] = time.time() * 1000 - 1
        result = await web.api_question_answer(web.QuestionAnswerRequest(
            questionId=question['id'], answers={'permission': ['允许本次']}))
        assert result['ok'] is False
        assert not record['future'].done()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert question['id'] not in web._HARNESS_QUESTIONS
    asyncio.run(exercise())


def test_question_timeout_does_not_produce_an_answer(monkeypatch):
    async def exercise():
        monkeypatch.setattr(web, 'TIMEOUT_CHAT', 0.01)
        events = []
        with pytest.raises(asyncio.TimeoutError):
            await web._harness_ask('isolated-question', [
                {'questionId': 'permission', 'question': 'Continue?'}
            ], lambda kind, text: events.append((kind, json.loads(text))))
        assert events[0][1]['id'] not in web._HARNESS_QUESTIONS
        assert [kind for kind, _ in events] == ['question']
    asyncio.run(exercise())
