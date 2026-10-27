"""Codex task handoffs. Native execution stays in its session workspace.

Only explicitly declared deliverables cross into the shared goal evidence tree.
Native tool notifications are observations, never before-execution guarantees.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import uuid

from .artifacts import ArtifactStore, file_path, inspect_file, MAX_FILE
from .task_store import TaskStore, TaskConflict
from .task_graph import parallel, ancestors
from .task_stages import stage_for_run


DELIVER_TOOL = {
    'type': 'function', 'name': 'easel_task_deliver',
    'description': 'Register declared task deliverables saved in this workspace. Paths must match the current stage or final file criteria. Does not approve quality.',
    'inputSchema': {'type': 'object', 'additionalProperties': False, 'required': ['files'],
                    'properties': {'files': {'type': 'array', 'minItems': 1, 'maxItems': 16,
                        'items': {'type': 'object', 'additionalProperties': False, 'required': ['path'],
                                  'properties': {'path': {'type': 'string'}}}}}},
}


class CodexTasks:
    def __init__(self, outputs):
        self.outputs = Path(outputs).resolve()
        self.store = TaskStore(outputs)

    def context(self, state, *, current=False):
        pair = self.store.run_context(state['sessionId'], state['turn_id'], current=current)
        if pair and (pair[0].get('engine') != 'codex' or pair[0].get('toolBudgetMode') != 'observed'):
            raise TaskConflict('该目标未授权Codex观察模式。')
        return pair

    @staticmethod
    def bundle(root, relative):
        info = inspect_file(root, relative)
        if info['status'] != 'ready':
            raise TaskConflict('交接文件不存在或不可读。')
        values = {}
        for name in [relative, *info['dependencies']]:
            path, name = file_path(root, name)
            if not path.is_file():
                raise TaskConflict('交接资源不完整。')
            data = path.read_bytes()
            if sum(map(len, values.values())) + len(data) > MAX_FILE:
                raise TaskConflict('交接文件及资源超过64MiB。')
            values[name] = data
        version = hashlib.sha256(json.dumps(sorted((name, hashlib.sha256(data).hexdigest())
                                                   for name, data in values.items())).encode()).hexdigest()
        if version != info['version'] or inspect_file(root, relative)['version'] != info['version']:
            raise TaskConflict('交接文件仍在变化，未采用该版本。')
        return info, values

    @staticmethod
    def copy_files(root, files):
        # All paths/data have been validated before the first replacement.
        for name, data in files.items():
            target, _ = file_path(root, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target, _ = file_path(root, name)  # Recheck after creating directories.
            temp = target.with_name(target.name + '.easel-' + uuid.uuid4().hex + '.tmp')
            try:
                temp.write_bytes(data)
                temp.replace(target)
            finally:
                temp.unlink(missing_ok=True)

    def prepare(self, state):
        pair = self.context(state, current=True)
        if not pair:
            return False
        goal, run = pair
        workspace = Path(state['workspace'])
        stage = stage_for_run(goal, run)
        upstream = ancestors(goal, stage['id']) if stage and parallel(goal) else None
        checks = [c for c in goal.get('checks', []) if c['type'] == 'file' and c['state'] == 'passed']
        for previous in goal.get('stages', []):
            if previous['status'] != 'completed' or (upstream is not None and previous['id'] not in upstream):
                continue
            checks.extend(c for c in previous['checks'] if c['type'] == 'file' and c['state'] == 'passed')
        incoming = {}
        for check in checks:
            info, values = self.bundle(self.outputs, file_path(self.outputs, check['value'])[1])
            if info['version'] != check.get('evidence'):
                raise TaskConflict('上游交接版本已变化，未复制新的未核验内容。')
            if any(name in incoming and incoming[name] != data for name, data in values.items()):
                raise TaskConflict('上游交接资源版本冲突。')
            incoming.update(values)
            if sum(map(len, incoming.values())) > MAX_FILE:
                raise TaskConflict('本轮上游交接资源合计超过64MiB。')
        self.context(state, current=True)
        self.copy_files(workspace, incoming)
        state['taskGoal'] = {'id': goal['id'], 'revision': run['revision'], 'toolBudgetMode': 'observed'}
        return True

    def guard(self, state, call, tool):
        self.context(state, current=True)
        result = self.store.guard(state['sessionId'], state.get('codexTurnId'), str(call), tool)
        if result.get('allowed') is not True:
            raise TaskConflict(result.get('reason') or '目标拒绝新的操作。')

    def progress(self, state, plan):
        if not isinstance(plan, list) or not plan:
            return
        steps = [{'id': hashlib.sha256((str(i) + item['step']).encode()).hexdigest()[:24],
                  'title': item['step'][:300], 'status': item['status']}
                 for i, item in enumerate(plan)]
        call = 'plan-' + hashlib.sha256(json.dumps(steps, sort_keys=True).encode()).hexdigest()
        self.guard(state, call, 'easel_goal_update')
        self.store.update_progress(state['sessionId'], call, steps)

    def deliver(self, state, files):
        if not isinstance(files, list) or not 1 <= len(files) <= 16:
            raise TaskConflict('每次交接1至16个声明文件。')
        workspace = Path(state['workspace'])
        with self.store.db() as db:
            row = db.execute('SELECT data FROM runs WHERE session=? AND turn=?',
                             (state['sessionId'], state['turn_id'])).fetchone()
            if not row:
                raise TaskConflict('目标运行不存在。')
            run = json.loads(row[0]); goal = self.store._get(db, 'goals', run['goalId'])
            self.store._require_session(db, state['sessionId'])
            if (goal.get('engine') != 'codex' or run['state'] != 'running' or goal['status'] != 'active'
                    or run['stopEpoch'] != goal['stopEpoch'] or run['revision'] != goal['revision']
                    or run.get('providerRunId') != state.get('codexTurnId')):
                raise TaskConflict('目标交接身份或版本已失效。')
            stage = stage_for_run(goal, run)
            criteria = list(stage['criteria']) if stage else []
            if not stage or (stage.get('access', 'write') == 'write' and stage.get('roleId') not in ('reviewer', 'publisher')):
                criteria += goal['criteria']
            allowed = {file_path(self.outputs, c['value'])[1] for c in criteria if c['type'] == 'file'}
            protected = {file_path(self.outputs, c['value'])[1] for s in goal.get('stages', [])
                         for c in s['criteria'] if c['type'] == 'file'} - allowed
            for previous in goal.get('stages', []):
                if previous['status'] != 'completed' or (stage and previous['id'] == stage['id']):
                    continue
                for check in previous.get('checks', []):
                    if check['type'] == 'file' and check['state'] == 'passed':
                        info = inspect_file(self.outputs, file_path(self.outputs, check['value'])[1])
                        protected.update(info['dependencies'])
            copied, mains = {}, []
            for item in files:
                if not isinstance(item, dict) or not isinstance(item.get('path'), str):
                    raise TaskConflict('交接路径无效。')
                _, relative = file_path(workspace, item['path'])
                if relative not in allowed:
                    raise TaskConflict('交接路径必须匹配当前阶段或最终文件条件。')
                _, values = self.bundle(workspace, relative)
                if any(file_path(self.outputs, name)[0].read_bytes() != values[name]
                       for name in protected.intersection(values)):
                    raise TaskConflict('交接资源不得覆盖其他阶段的证据。')
                for path in values:
                    file_path(self.outputs, path)
                copied.update(values); mains.append({'path': relative})
            if sum(map(len, copied.values())) > MAX_FILE:
                raise TaskConflict('单次交接超过64MiB。')
            self.copy_files(self.outputs, copied)
        artifacts = ArtifactStore(self.outputs)
        values = artifacts.present(state['sessionId'], state['turn_id'], mains, source='codex-task')
        if goal['sessionId'] != state['sessionId']:
            artifacts.present(goal['sessionId'], state['turn_id'], mains, source='codex-task')
        return values
