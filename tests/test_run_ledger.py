import json
from pathlib import Path

from web.run_ledger import create, is_active, mark, read


def test_ledger_preserves_identity_and_does_not_recreate_a_turn(tmp_path: Path):
    first = create(tmp_path, "turn-1", session_id="chat", session_key="agent:main:chat", model_ref="relay/model")
    again = create(tmp_path, "turn-1", session_id="other", session_key="other")
    assert first["turnId"] == "turn-1"
    assert again["sessionId"] == "chat"
    assert again["eventSeq"] == 1
    assert is_active(again)


def test_ledger_links_provider_run_and_terminal_settlement(tmp_path: Path):
    create(tmp_path, "turn-2", session_id="chat", session_key="agent:main:chat")
    accepted = mark(tmp_path, "turn-2", event="provider_accepted", status="running",
                    provider_run_id="run-2", transport="native", last_event_id=4)
    assert accepted["providerRunId"] == "run-2"
    assert accepted["transport"] == "native"
    assert accepted["lastEventId"] == 4
    assert accepted["events"][-1]["type"] == "provider_accepted"
    terminal = mark(tmp_path, "turn-2", event="terminal", status="failed",
                    stop_reason="gateway_stream_interrupted",
                    error={"code": "chat_supervisor_lost", "message": "safe"},
                    settled=True, resource_settled=True)
    assert terminal["settled"] and terminal["resourceSettled"]
    assert not is_active(terminal)
    assert terminal["error"]["code"] == "chat_supervisor_lost"


def test_ledger_event_history_is_bounded_and_atomic_file_is_valid(tmp_path: Path):
    create(tmp_path, "turn-3", session_id="chat", session_key="agent:main:chat")
    for index in range(250):
        mark(tmp_path, "turn-3", event="sse", last_event_id=index)
    value = read(tmp_path, "turn-3")
    assert value["eventSeq"] == 250 + 1
    assert len(value["events"]) == 200
    assert json.loads((tmp_path / "runs" / "turn-3.json").read_text(encoding="utf-8"))["turnId"] == "turn-3"
