#!/usr/bin/env python3
"""Explicit Meshy character experiments, isolated from the running OfficeAvatar rig."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs" / "meshy-character-spec.json"
QUARANTINE = ROOT / "outputs" / "meshy-quarantine"
API_BASE = "https://api.meshy.ai/openapi"
ENDPOINTS = {"preview": "/v2/text-to-3d", "refine": "/v2/text-to-3d", "rigging": "/v1/rigging"}
TASK_TYPES = {"preview": "text-to-3d-preview", "refine": "text-to-3d-refine", "rigging": "rig"}
STATUSES = {"PENDING", "IN_PROGRESS", "SUCCEEDED", "FAILED", "CANCELED"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def run_directory(name: str) -> Path:
    reserved = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name) or name in reserved:
        raise ValueError("Run name must be 1-64 lowercase letters/digits/hyphens, not a device name")
    path = (QUARANTINE / name).resolve()
    if not path.is_relative_to(QUARANTINE.resolve()):
        raise ValueError("Run directory escapes the asset quarantine")
    return path


def task_id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value):
        raise ValueError("Invalid Meshy task ID")
    return value


def api_key() -> str:
    # Match project .env conventions without executing or expanding its content.
    key = os.environ.get("MESHY_API_KEY", "").strip()
    if not key and (ROOT / ".env").is_file():
        for raw in (ROOT / ".env").read_text(encoding="utf-8-sig").splitlines():
            name, separator, value = raw.strip().removeprefix("export ").partition("=")
            if separator and name.strip() == "MESHY_API_KEY":
                key = value.strip().strip("\"").strip("'")
                break
    if not key:
        raise ValueError("MESHY_API_KEY is missing; plan works offline without it")
    if "\n" in key or "\r" in key:
        raise ValueError("MESHY_API_KEY contains an invalid newline")
    return key


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Do not forward credentials or signed asset requests to another host.
        return None


def api_request(method: str, endpoint: str, key: str, body: dict | None = None) -> dict:
    request = Request(API_BASE + endpoint, method=method,
                      data=json.dumps(body).encode() if body is not None else None,
                      headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with build_opener(NoRedirect()).open(request, timeout=45) as response:
            payload = response.read(4 * 1024 * 1024 + 1)
            if len(payload) > 4 * 1024 * 1024:
                raise ValueError("Meshy JSON response exceeded 4 MiB")
            result = json.loads(payload)
            if not isinstance(result, dict):
                raise ValueError("Meshy returned an unexpected response shape")
            return result
    except HTTPError as exc:
        # Response bodies can echo credentials or URLs. Print only the status.
        raise RuntimeError(f"Meshy HTTP {exc.code}; no automatic retry was made") from None
    except (URLError, TimeoutError, OSError):
        raise RuntimeError("Meshy request did not complete; no automatic retry was made") from None


def plan(name: str, species: str) -> dict:
    spec = read_json(SPEC)
    prompt = spec["prompt_template"].format(species=species, features=spec["species"][species])
    if len(prompt) > 600 or len(spec["refine"]["texture_prompt"]) > 600:
        raise ValueError("Prompt exceeds the reference MCP's conservative 600-character limit")
    preview = {**spec["preview"], "ai_model": spec["ai_model"], "prompt": prompt}
    result = {"schema_version": 1, "run": name, "species": species, "created_at": now(),
              "status": "PLANNED_NOT_SUBMITTED", "automatic_runtime_import": False,
              "requests": {"preview": preview, "refine": {**spec["refine"], "ai_model": spec["ai_model"]},
                           "rigging": spec["rigging"]}, "review_budget": spec["review_budget"], "tasks": {}}
    directory = run_directory(name)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "run.json").open("x", encoding="utf-8") as output:
        output.write(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    return result


@contextmanager
def lock_run(directory: Path):
    lock = directory / ".request.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise ValueError("This run is locked; inspect any running command before clearing a stale .request.lock") from None
    os.close(fd)
    try:
        yield
    finally:
        lock.unlink()


def check_task(response: dict, stage: str, expected_id: str) -> dict:
    if response.get("id") != expected_id or response.get("type") != TASK_TYPES[stage]:
        raise ValueError("Task ID/type does not match this generation stage")
    if response.get("status") not in STATUSES:
        raise ValueError("Unknown Meshy task status; no dependent task will be created")
    return {key: response[key] for key in ("id", "type", "status", "progress", "created_at", "finished_at", "expires_at", "consumed_credits") if key in response}


def retrieve(stage: str, identifier: str, key: str) -> dict:
    response = api_request("GET", f"{ENDPOINTS[stage]}/{task_id(identifier)}", key)
    check_task(response, stage, identifier)
    return response


def create(name: str, stage: str, key: str) -> dict:
    directory = run_directory(name)
    with lock_run(directory):
        path = directory / "run.json"
        manifest = read_json(path)
        if stage in manifest["tasks"]:
            raise ValueError("This stage already has a submission record; use status instead of another charged POST")
        body = dict(manifest["requests"][stage])
        previous = {"refine": "preview", "rigging": "refine"}.get(stage)
        if previous:
            identifier = manifest["tasks"].get(previous, {}).get("id")
            if not identifier:
                raise ValueError(f"A completed {previous} task is required")
            response = retrieve(previous, identifier, key)
            if response["status"] != "SUCCEEDED":
                raise ValueError(f"The {previous} task has not SUCCEEDED; no charged POST was made")
            if stage == "rigging" and not response.get("model_urls", {}).get("glb"):
                raise ValueError("Rigging requires a textured refine result with a GLB asset")
            body["preview_task_id" if stage == "refine" else "input_task_id"] = identifier
        # Persist intent before the only POST. A timeout may still create a paid
        # task, so any submission record blocks accidental duplicate generation.
        record = {"submission": "AWAITING_RESPONSE", "attempted_at": now(), "request": body}
        manifest["tasks"][stage] = record
        save_json(path, manifest)
        try:
            response = api_request("POST", ENDPOINTS[stage], key, body)
            record["id"] = task_id(response.get("result"))
            record["submission"] = "SUBMITTED"
        except Exception:
            record["submission"] = "UNKNOWN_DO_NOT_RESUBMIT"
            save_json(path, manifest)
            raise
        save_json(path, manifest)
        return {"stage": stage, "id": record["id"], "submission": record["submission"]}


def status(name: str, stage: str, key: str, recovered_id: str | None = None) -> dict:
    directory = run_directory(name)
    with lock_run(directory):
        path = directory / "run.json"
        manifest = read_json(path)
        record = manifest["tasks"].get(stage, {})
        identifier = record.get("id") or recovered_id
        if not identifier:
            raise ValueError("No task ID; inspect Meshy task history, then use status --task-id to recover it")
        if recovered_id and record.get("id") and recovered_id != record["id"]:
            raise ValueError("Cannot replace a saved task ID with another task")
        response = retrieve(stage, identifier, key)
        record.update(check_task(response, stage, identifier))
        record["submission"] = "SUBMITTED"
        manifest["tasks"][stage] = record
        save_json(path, manifest)
        return {"stage": stage, **check_task(response, stage, identifier)}


def asset_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "assets.meshy.ai" or parsed.port not in (None, 443) or parsed.username or parsed.password:
        raise ValueError("Asset URL must use HTTPS on assets.meshy.ai")
    return url


def read_asset(url: str, maximum: int) -> bytes:
    try:
        # Signed result URLs authenticate themselves; never send the API key.
        with build_opener(NoRedirect()).open(Request(asset_url(url)), timeout=60) as response:
            data = response.read(maximum + 1)
            if len(data) > maximum:
                raise ValueError("Asset exceeds the quarantine download limit")
            return data
    except (HTTPError, URLError, TimeoutError, OSError):
        raise RuntimeError("Asset download failed; refresh task status and try download again") from None


def inspect_glb(data: bytes, budget: dict) -> dict:
    if len(data) < 20:
        raise ValueError("Asset is not a GLB file")
    magic, version, length, chunk_length, chunk_type = struct.unpack_from("<4sIIII", data)
    if magic != b"glTF" or version != 2 or length != len(data) or chunk_type != 0x4E4F534A or chunk_length > len(data) - 20:
        raise ValueError("Invalid GLB 2.0 header or JSON chunk")
    gltf = json.loads(data[20:20 + chunk_length])
    triangles = 0
    issues = []
    accessors = gltf.get("accessors", [])
    for mesh in gltf.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            if primitive.get("mode", 4) != 4:
                issues.append("Non-triangle primitive requires manual review")
                continue
            index = primitive.get("indices", primitive.get("attributes", {}).get("POSITION"))
            if not isinstance(index, int) or not 0 <= index < len(accessors):
                raise ValueError("GLB primitive refers to a missing accessor")
            count = accessors[index].get("count")
            if not isinstance(count, int) or count < 0 or count % 3:
                raise ValueError("Invalid triangle accessor count")
            triangles += count // 3
    if not triangles:
        issues.append("No triangle geometry found")
    if triangles > budget["maximum_triangles"]:
        issues.append("Triangle count exceeds the character budget")
    if len(gltf.get("materials", [])) > budget["maximum_materials"]:
        issues.append("Material count exceeds the character budget")
    if any(entry.get("uri") and not entry["uri"].startswith("data:") for entry in gltf.get("buffers", []) + gltf.get("images", [])):
        issues.append("External resources must be embedded before any import")
    return {"container_checks_passed": not issues, "triangles": triangles,
            "materials": len(gltf.get("materials", [])), "skins": len(gltf.get("skins", [])),
            "animations": len(gltf.get("animations", [])), "issues": issues,
            "rig_compatibility_verified": False, "browser_verified": False, "ready_for_runtime_import": False}


def download(name: str, stage: str, key: str) -> dict:
    directory = run_directory(name)
    with lock_run(directory):
        manifest = read_json(directory / "run.json")
        identifier = manifest["tasks"].get(stage, {}).get("id")
        if not identifier:
            raise ValueError("No task ID is saved for this stage")
        response = retrieve(stage, identifier, key)
        if response["status"] != "SUCCEEDED":
            raise ValueError("Only SUCCEEDED task assets can be downloaded")
        url = response.get("result", {}).get("rigged_character_glb_url") if stage == "rigging" else response.get("model_urls", {}).get("glb")
        if not url:
            raise ValueError("The completed task has no GLB asset")
        output = directory / stage
        if output.exists():
            raise ValueError("This stage already has downloaded assets; inspect them before another download")
        budget = manifest["review_budget"]
        data = read_asset(url, budget["maximum_glb_bytes"])
        report = inspect_glb(data, budget)
        output.mkdir()
        (output / "character.glb").write_bytes(data)
        # A GLB can embed its PBR images. Separate images are also retained when
        # supplied, so Blender/material review does not depend on expiring URLs.
        files = {"character.glb": hashlib.sha256(data).hexdigest()}
        try:
            for index, textures in enumerate(response.get("texture_urls", [])):
                if index >= 4:
                    raise ValueError("More than four material texture sets require manual download")
                for kind in ("base_color", "metallic", "roughness", "normal", "emission"):
                    if textures.get(kind):
                        image = read_asset(textures[kind], 32 * 1024 * 1024)
                        # Keep a neutral suffix: official results may use PNG or JPEG.
                        suffix = ".png" if image.startswith(b"\x89PNG\r\n\x1a\n") else ".jpg" if image.startswith(b"\xff\xd8\xff") else None
                        if suffix is None:
                            raise ValueError("Texture response is not PNG or JPEG")
                        filename = f"material-{index}-{kind}{suffix}"
                        (output / filename).write_bytes(image)
                        files[filename] = hashlib.sha256(image).hexdigest()
        finally:
            report.update({"stage": stage, "task_id": identifier, "downloaded_at": now(), "sha256": files})
            save_json(output / "inspection.json", report)
        return {"directory": str(output), **report}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("plan", "create", "status", "download"):
        child = sub.add_parser(command, help="Offline preparation" if command == "plan" else "Creates a paid Meshy task" if command == "create" else "Read existing remote results")
        child.add_argument("--run", required=True)
        if command == "plan":
            child.add_argument("--species", choices=("cat", "rabbit", "fox", "bear"), default="cat")
        else:
            child.add_argument("--stage", choices=tuple(ENDPOINTS), required=True)
        if command == "status":
            child.add_argument("--task-id", help="Recover a task found in Meshy history; never creates a task")
    args = parser.parse_args(argv)
    try:
        if args.command == "plan":
            result = plan(args.run, args.species)
        elif args.command == "status":
            result = status(args.run, args.stage, api_key(), args.task_id)
        else:
            result = {"create": create, "download": download}[args.command](args.run, args.stage, api_key())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, RuntimeError, OSError, KeyError, TypeError) as exc:
        # Our own errors never include HTTP response bodies, auth or signed URLs.
        print(f"Meshy character workflow: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
