import json
from pathlib import Path
import pytest
import threading


def _failure(path: str, message: str = "Local media path is not under an allowed directory"):
    return {
        "name": "view_image",
        "id": "operation-1",
        "path": path,
    }, {"isError": True, "content": message}


def test_repair_agent_copies_outputs_image_once(tmp_path: Path):
    from web.repair_agent import RepairAgent, context_for_session

    outputs = tmp_path / "outputs"
    source = outputs / "topic" / "card_1.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"png")
    workspace = tmp_path / "workspace"
    agent = RepairAgent(outputs, "session", "turn", workspace=workspace)

    row, result = _failure(str(source))
    receipt = agent.on_failure(row, result)
    assert receipt["status"] == "repaired"
    target = Path(receipt["targetPath"])
    assert target.is_file()
    assert target.read_bytes() == b"png"
    assert "repaired" in context_for_session(outputs, "session")
    saved = json.loads(Path(receipt["receiptPath"]).read_text(encoding="utf-8"))
    assert saved["sourcePath"] == str(source.resolve())


def test_repair_agent_rejects_outputs_escape_and_non_images(tmp_path: Path):
    from web.repair_agent import RepairAgent

    outputs = tmp_path / "outputs"
    outputs.mkdir()
    agent = RepairAgent(outputs, "session", "turn", workspace=tmp_path / "workspace")
    row, result = _failure(str(tmp_path / "outside.png"))
    assert agent.on_failure(row, result)["status"] == "manual"
    row2, result2 = _failure(str(outputs / "topic" / "note.txt"))
    assert agent.on_failure({**row2, "id": "operation-2"}, result2)["status"] == "manual"


def test_repair_agent_is_bounded_and_does_not_retry_provider_timeout(tmp_path: Path):
    from web.repair_agent import RepairAgent

    outputs = tmp_path / "outputs"
    image = outputs / "topic" / "card.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"png")
    agent = RepairAgent(outputs, "session", "turn", workspace=tmp_path / "workspace")
    row, result = _failure(str(image))
    first = agent.on_failure(row, result)
    duplicate = agent.on_failure(row, result)
    assert first["status"] == "repaired"
    assert duplicate["status"] == "ignored"
    timeout = agent.on_failure(
        {"id": "provider-1", "name": "chat_completion", "path": ""},
        {"isError": True, "content": "model_provider_timeout"},
    )
    assert timeout["status"] == "manual"
    assert "never retried" in timeout["reason"]


def test_execution_store_attaches_failure_repair(tmp_path: Path):
    from easel.execution_store import ExecutionStore

    seen = []
    store = ExecutionStore(tmp_path, "session", "turn", on_failure=lambda row, result: seen.append(row["name"]) or {"status": "manual"})
    payload = {"stream": "tool", "seq": 1, "data": {"phase": "start", "toolCallId": "call", "name": "view_image", "args": {"path": "outputs/a.png"}}}
    store.consume(payload)
    snapshot = store.consume({"stream": "tool", "seq": 2, "data": {"phase": "result", "toolCallId": "call", "isError": True, "result": {"content": "failed"}}})
    assert seen == ["view_image"]
    assert snapshot["operations"][0]["repair"]["status"] == "manual"


def test_repair_context_is_injected_into_next_chat_message(monkeypatch, tmp_path: Path):
    from web import app
    from web.repair_agent import RepairAgent

    outputs = tmp_path / "outputs"
    image = outputs / "topic" / "card.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"png")
    RepairAgent(outputs, "session", "turn", workspace=tmp_path / "workspace").on_failure(
        {"id": "call", "name": "view_image", "path": str(image)},
        {"isError": True, "content": "Local media path is not under an allowed directory"},
    )
    monkeypatch.setattr(app, "OUTPUTS_DIR", outputs)
    message = app._chat_message(app.ChatRequest(message="继续", sessionId="session"))
    assert "修复 Agent 回执" in message
    assert "targetPath" in message
    assert "\n\n〔修复 Agent 回执" in message


def test_repair_agent_accepts_outputs_relative_path(tmp_path: Path):
    from web.repair_agent import RepairAgent

    outputs = tmp_path / "outputs"
    source = outputs / "topic" / "relative.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"png")
    agent = RepairAgent(outputs, "session", "turn", workspace=tmp_path / "workspace")
    row, result = _failure("outputs/topic/relative.png")
    receipt = agent.on_failure(row, result)
    assert receipt["status"] == "repaired"


def test_xiaohongshu_skill_context_routes_card_workflow():
    from web import app

    message = app._chat_message(app.ChatRequest(
        message="做一组小红书卡片",
        selectedSkills=["card-xiaohongshu"],
    ))
    assert "〔小红书组别执行契约〕" in message
    assert "card-design → card-xiaohongshu → card_audit" in message
    assert "不凭文件名猜图" in message


def test_repair_budget_survives_supervisor_restart(tmp_path: Path):
    from web.repair_agent import RepairAgent

    outputs = tmp_path / "outputs"
    image = outputs / "topic" / "card.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"png")
    first = RepairAgent(outputs, "session", "turn-a", workspace=tmp_path / "workspace",
                        max_session_repairs=1)
    row, result = _failure(str(image))
    assert first.on_failure(row, result)["status"] == "repaired"

    restarted = RepairAgent(outputs, "session", "turn-b", workspace=tmp_path / "workspace",
                            max_session_repairs=1)
    row2, result2 = _failure(str(image))
    row2["id"] = "operation-2"
    receipt = restarted.on_failure(row2, result2)
    assert receipt["status"] == "manual"
    assert receipt["reason"] == "session repair limit reached"


def test_repair_stop_gate_writes_manual_without_copying(tmp_path: Path):
    from web.repair_agent import RepairAgent

    outputs = tmp_path / "outputs"
    image = outputs / "topic" / "card.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"png")
    stopped = threading.Event()
    stopped.set()
    agent = RepairAgent(outputs, "session", "turn", workspace=tmp_path / "workspace",
                        stop_event=stopped)
    receipt = agent.on_failure(*_failure(str(image)))
    assert receipt["status"] == "manual"
    assert receipt["reason"] == "repair stopped by user"
    assert not (tmp_path / "workspace" / "_inspect").exists()


def test_execution_lifecycle_distinguishes_repairable_and_unknown(tmp_path: Path):
    from easel.execution_store import ExecutionStore

    store = ExecutionStore(tmp_path, "session", "turn", on_failure=lambda row, result: {
        "status": "repaired", "action": "copy_image_for_inspection"
    })
    store.consume({"stream": "tool", "seq": 1, "data": {
        "phase": "start", "toolCallId": "call", "name": "view_image", "args": {"path": "outputs/a.png"}
    }})
    snapshot = store.consume({"stream": "tool", "seq": 2, "data": {
        "phase": "result", "toolCallId": "call", "isError": True,
        "result": {"content": "Local media path is not under an allowed directory"}
    }})
    assert snapshot["operations"][0]["lifecycleState"] == "repairable"
    assert [item["state"] for item in snapshot["operations"][0]["lifecycleHistory"]] == [
        "admitted", "running", "manual", "repairable"
    ]
    store.finish()
    assert store.snapshot()["operations"][0]["lifecycleState"] == "repairable"


def test_execution_lifecycle_marks_success_and_unconfirmed(tmp_path: Path):
    from easel.execution_store import ExecutionStore

    success = ExecutionStore(tmp_path / "success", "session", "turn")
    success.consume({"stream": "tool", "seq": 1, "data": {
        "phase": "start", "toolCallId": "call", "name": "read", "args": {"path": "outputs/a.txt"}
    }})
    snapshot = success.consume({"stream": "tool", "seq": 2, "data": {
        "phase": "result", "toolCallId": "call", "isError": False,
        "result": {"content": "ok"}
    }})
    assert snapshot["operations"][0]["lifecycleState"] == "succeeded"

    pending = ExecutionStore(tmp_path / "pending", "session", "turn")
    pending.consume({"stream": "tool", "seq": 1, "data": {
        "phase": "start", "toolCallId": "call", "name": "read", "args": {"path": "outputs/a.txt"}
    }})
    pending.finish()
    assert pending.snapshot()["operations"][0]["lifecycleState"] == "unknown"


def test_xiaohongshu_publish_cannot_share_read_only_phase():
    from web import app

    with pytest.raises(app.HTTPException) as exc:
        app._validate_xhs_skill_selection({
            "skill-xhs-publisher": {},
            "skill-xhs-analyzer": {},
        })
    assert exc.value.status_code == 400
