import json
from pathlib import Path


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
