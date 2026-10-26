"""Validated goal contracts and wall-clock schedules; no model calls here."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, model_validator
from easel.artifacts import file_path, inspect_file


class Criterion(BaseModel):
    model_config = {'extra': 'forbid'}
    type: Literal['file', 'text', 'review']
    label: str = Field(min_length=1, max_length=200)
    value: str = Field(default='', max_length=1000)

    @model_validator(mode='after')
    def nonempty(self):
        if self.type != 'review' and not self.value.strip():
            raise ValueError('文件或文字验收项需要填写路径或关键文字')
        return self


class GoalStage(BaseModel):
    model_config = {'extra': 'forbid'}
    id: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9_.-]+$')
    title: str = Field(min_length=1, max_length=160)
    roleId: str
    objective: str = Field(min_length=3, max_length=3000)
    criteria: list[Criterion] = Field(min_length=1, max_length=8)

    @model_validator(mode='after')
    def valid_contract(self):
        from easel.agent_roles import get_role
        if not get_role(self.roleId):
            raise ValueError('阶段角色不存在')
        if any(c.type == 'review' for c in self.criteria):
            raise ValueError('阶段交接使用文件或文字证据；人工质量验收放在最终目标')
        return self


class GoalSpec(BaseModel):
    model_config = {'extra': 'forbid'}
    objective: str = Field(min_length=3, max_length=6000)
    modelRef: str = Field(min_length=3, max_length=300, pattern=r'^[^\s/]+/[^\s]+$')
    criteria: list[Criterion] = Field(min_length=1, max_length=16)
    maxIterations: int = Field(default=5, ge=1, le=20, strict=True)
    maxSeconds: int = Field(default=1200, ge=60, le=7200, strict=True)
    maxTools: int = Field(default=40, ge=1, le=200, strict=True)
    maxImages: int = Field(default=0, ge=0, le=16, strict=True)
    workflow: Literal['research-delivery'] | None = None
    stages: list[GoalStage] = Field(default_factory=list, max_length=8)

    @model_validator(mode='after')
    def stage_contract(self):
        if self.workflow and self.stages:
            raise ValueError('选择内置协作流程或自定义阶段之一')
        count = 4 if self.workflow else len(self.stages)
        if count > self.maxIterations:
            raise ValueError('执行轮次上限不能少于协作阶段数')
        if len({s.id for s in self.stages}) != len(self.stages):
            raise ValueError('阶段ID不能重复')
        return self


class GoalStep(BaseModel):
    model_config = {'extra': 'forbid'}
    id: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9_.-]+$')
    title: str = Field(min_length=1, max_length=300)
    status: Literal['pending', 'in_progress', 'completed', 'blocked'] = 'pending'
    detail: str = Field(default='', max_length=1200)


class GoalProgress(BaseModel):
    model_config = {'extra': 'forbid'}
    steps: list[GoalStep] = Field(min_length=1, max_length=32)

    @model_validator(mode='after')
    def unique_ids(self):
        if len({s.id for s in self.steps}) != len(self.steps):
            raise ValueError('步骤ID不能重复')
        if sum(s.status == 'in_progress' for s in self.steps) > 1:
            raise ValueError('每次仅一个进行中步骤')
        return self


class Schedule(BaseModel):
    model_config = {'extra': 'forbid'}
    kind: Literal['once', 'interval', 'daily', 'workdays', 'weekly', 'monthly']
    timezone: str = 'Asia/Shanghai'
    at: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    minutes: int = Field(default=60, ge=5, le=10080, strict=True)
    time: str = Field(default='09:00', pattern=r'^([01]\d|2[0-3]):[0-5]\d$')
    weekdays: list[int] = Field(default_factory=lambda: [0], min_length=1, max_length=7)
    day: int = Field(default=1, ge=1, le=31, strict=True)

    @model_validator(mode='after')
    def validate_rule(self):
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError('未知时区，请使用 Asia/Shanghai 等 IANA 时区') from None
        if any(type(d) is not int or not 0 <= d <= 6 for d in self.weekdays):
            raise ValueError('星期必须为0至6')
        if self.kind in ('once', 'interval') and self.at is None:
            raise ValueError('单次或固定间隔需要起始时间')
        return self


def next_time(rule, after):
    s = rule if isinstance(rule, Schedule) else Schedule.model_validate(rule)
    if s.kind == 'once':
        return s.at if s.at > after else None
    if s.kind == 'interval':
        if s.at > after:
            return s.at
        step = s.minutes * 60
        return s.at + (int((after - s.at) // step) + 1) * step
    tz = ZoneInfo(s.timezone)
    local = datetime.fromtimestamp(after, tz)
    h, m = map(int, s.time.split(':'))
    if s.kind == 'monthly':
        # Same shape as Codex's monthly example (BYMONTHDAY=1;BYHOUR=9). Months
        # without the selected day are skipped, not clamped.
        for delta in range(15):
            index = local.year * 12 + (local.month - 1) + delta
            year, month = divmod(index, 12)
            try:
                candidate = datetime(year, month + 1, s.day, h, m, tzinfo=tz, fold=0)
            except ValueError:
                continue
            ts = candidate.timestamp()
            roundtrip = datetime.fromtimestamp(ts, tz)
            if roundtrip.replace(tzinfo=None) != candidate.replace(tzinfo=None):
                continue
            if ts > after:
                return ts
        return None
    for delta in range(9):
        date = local.date() + timedelta(days=delta)
        if s.kind == 'workdays' and date.weekday() > 4:
            continue
        if s.kind == 'weekly' and date.weekday() not in s.weekdays:
            continue
        # One slot per local day: earlier fold at DST fall-back, skip missing time.
        candidate = datetime(date.year, date.month, date.day, h, m, tzinfo=tz, fold=0)
        ts = candidate.timestamp()
        roundtrip = datetime.fromtimestamp(ts, tz)
        if roundtrip.replace(tzinfo=None) != candidate.replace(tzinfo=None):
            continue
        if ts > after:
            return ts
    return None


def upcoming(rule, after, count=3):
    result = []
    for _ in range(count):
        after = next_time(rule, after)
        if after is None:
            break
        result.append(after)
    return result


def latest_time(rule, now):
    """Most recent slot, without iterating through an offline interval backlog."""
    s = Schedule.model_validate(rule)
    if s.kind in ('once', 'interval'):
        if s.at > now:
            return None
        if s.kind == 'once':
            return s.at
        return s.at + int((now - s.at) // (s.minutes * 60)) * s.minutes * 60
    if s.kind == 'monthly':
        current, latest = now - 70 * 86400, None
        for _ in range(5):
            current = next_time(s, current)
            if current is None or current > now:
                break
            latest = current
        return latest
    current, latest = now - 9 * 86400, None
    for _ in range(12):
        current = next_time(s, current)
        if current is None or current > now:
            break
        latest = current
    return latest


def check_goal(outputs, goal, text, reviewed=False):
    checks = []
    for i, spec in enumerate(goal['criteria']):
        c = {**spec, 'index': i, 'state': 'pending', 'evidence': ''}
        try:
            if spec['type'] == 'file':
                _, relative = file_path(outputs, spec['value'])
                file = inspect_file(outputs, relative)
                ready = file['status'] == 'ready' and all(inspect_file(outputs, d)['status'] == 'ready' for d in file.get('dependencies', []))
                c.update(state='passed' if ready else 'failed', evidence=file['version'], detail='文件及本地依赖已核验' if ready else '文件或依赖缺失')
            elif spec['type'] == 'text':
                passed = spec['value'] in text
                c.update(state='passed' if passed else 'failed', evidence=hashlib.sha256(text.encode()).hexdigest(), detail='本轮输出包含指定文字' if passed else '本轮输出未包含指定文字')
            else:
                c.update(state='passed' if reviewed else 'pending', detail='用户已确认质量' if reviewed else '等待用户检查实际结果')
        except (OSError, ValueError) as exc:
            c.update(state='error', detail='证据无法核验，请检查文件路径、格式与读写状态')
        checks.append(c)
    # Keep the complete output hash above for audit. Rewording an answer or a
    # plan is not progress toward a failed criterion. Stable completed step IDs
    # describe reported work only, not independent quality verification.
    evidence = [(c['type'], c['state'],
                 c['evidence'] if c['type'] == 'file' else c.get('value', '') if c['state'] == 'passed' else '')
                for c in checks]
    completed = sorted(s['id'] for s in goal.get('steps', []) if s['status'] == 'completed')
    fingerprint = hashlib.sha256(json.dumps({'checks': evidence, 'completedSteps': completed}, sort_keys=True).encode()).hexdigest()
    return checks, fingerprint
