"""Durable goal/automation admission. Never replay a dispatched model request."""
from contextlib import contextmanager
import json
from pathlib import Path
import re
import sqlite3
import time
import uuid

from easel.task_graph import parallel, admissible_stages, affected_stages, ancestors, worker_session, PLANNED_WORKFLOW


SAFE_ID = re.compile(r'[A-Za-z0-9_.-]{1,120}\Z')


class TaskConflict(ValueError):
    pass


def ident():
    return uuid.uuid4().hex


def valid_checks(goal, checks):
    """A partial/mismatched verification must never omit required criteria."""
    return (isinstance(checks, list) and len(checks) == len(goal['criteria']) and
            all(isinstance(c, dict) and c.get('state') in ('passed', 'failed', 'pending', 'error') and
                all(c.get(k, '') == spec.get(k, '') for k in ('type', 'label', 'value'))
                for c, spec in zip(checks, goal['criteria'])))


class TaskStore:
    def __init__(self, outputs, clock=time.time):
        self.outputs = Path(outputs).resolve()
        self.path = self.outputs / '_automation' / 'tasks.sqlite3'
        self.clock = clock

    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.executescript('''
          CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY, session TEXT, status TEXT, data TEXT);
          CREATE UNIQUE INDEX IF NOT EXISTS one_current_goal ON goals(session)
            WHERE status NOT IN ('completed','cancelled');
          CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, enabled INTEGER, due REAL, data TEXT);
          CREATE INDEX IF NOT EXISTS plans_due ON plans(enabled,due);
          CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, goal TEXT, session TEXT, turn TEXT UNIQUE,
            state TEXT, owner TEXT, lease REAL, dispatched INTEGER DEFAULT 0, data TEXT);
          CREATE UNIQUE INDEX IF NOT EXISTS one_live_task_session ON runs(session)
            WHERE state IN ('queued','running','unconfirmed');
          CREATE TABLE IF NOT EXISTS slots(plan TEXT, at REAL, run TEXT, PRIMARY KEY(plan,at));
          CREATE TABLE IF NOT EXISTS manual_requests(plan TEXT, request TEXT, run TEXT,
            PRIMARY KEY(plan,request));
          CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, data TEXT);
          CREATE TABLE IF NOT EXISTS deleted_sessions(id TEXT PRIMARY KEY, at REAL,
            revision INTEGER, notice_pending INTEGER DEFAULT 1);
          CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,
            session TEXT, turn TEXT UNIQUE, data TEXT);
          CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
            session TEXT, kind TEXT, data TEXT, at REAL);
          CREATE TABLE IF NOT EXISTS chat_leases(session TEXT PRIMARY KEY, turn TEXT, until REAL);
          CREATE TABLE IF NOT EXISTS image_reservations(goal TEXT, request TEXT, PRIMARY KEY(goal,request));
          CREATE TABLE IF NOT EXISTS tool_reservations(goal TEXT, call TEXT, PRIMARY KEY(goal,call));
          CREATE TABLE IF NOT EXISTS stage_reworks(goal TEXT, request TEXT, data TEXT,
            PRIMARY KEY(goal,request));
        ''')
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _get(db, table, key):
        row = db.execute(f'SELECT data FROM {table} WHERE id=?', (key,)).fetchone()
        if not row:
            raise TaskConflict('记录不存在或已移除。')
        return json.loads(row[0])

    def _goal(self, db, goal):
        goal['updatedAt'] = self.clock()
        db.execute('INSERT INTO goals VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET session=excluded.session,status=excluded.status,data=excluded.data',
                   (goal['id'], goal['sessionId'], goal['status'], json.dumps(goal, ensure_ascii=False)))

    def _event(self, db, session, kind, value):
        return db.execute('INSERT INTO events(session,kind,data,at) VALUES(?,?,?,?)',
                   (session, kind, json.dumps(value, ensure_ascii=False), self.clock())).lastrowid

    @staticmethod
    def _require_session(db, session):
        if session and (db.execute('SELECT 1 FROM deleted_sessions WHERE id=?', (session,)).fetchone() or db.execute(
                'SELECT 1 FROM runs r JOIN goals g ON r.goal=g.id JOIN deleted_sessions d ON g.session=d.id WHERE r.session=?', (session,)).fetchone()):
            raise TaskConflict('原对话已删除，请新建对话。')

    def require_session(self, session):
        with self.db() as db:
            self._require_session(db, session)

    @staticmethod
    def _deleted_sessions(db):
        return [dict(row) for row in db.execute('SELECT id,at,revision FROM deleted_sessions ORDER BY revision')]

    def delete_session(self, session):
        """Commit deletion and scheduling changes together; retain run/artifact history."""
        if not isinstance(session, str) or not SAFE_ID.fullmatch(session):
            raise TaskConflict('无效会话。')
        with self.db() as db:
            row = db.execute('SELECT id,at,revision FROM deleted_sessions WHERE id=?', (session,)).fetchone()
            if row:
                return dict(row)
            at = self.clock()
            revision = self._event(db, session, 'session_deleted', {})
            db.execute('INSERT INTO deleted_sessions VALUES(?,?,?,1)', (session, at, revision))
            for row in db.execute('SELECT data FROM goals WHERE session=?', (session,)).fetchall():
                g = json.loads(row[0])
                if g['status'] not in ('completed', 'cancelled'):
                    g.update(status='cancelled', reason='原对话已删除', cancelRequested=True,
                             stopEpoch=g['stopEpoch'] + 1)
                    self._goal(db, g)
            for row in db.execute("SELECT data FROM runs WHERE (session=? OR goal IN (SELECT id FROM goals WHERE session=?)) AND state='queued'", (session, session)).fetchall():
                r = json.loads(row[0]); r.update(state='stopped', finishedAt=at, reason='原对话已删除')
                db.execute("UPDATE runs SET state='stopped',data=? WHERE id=?", (json.dumps(r), r['id']))
            for row in db.execute('SELECT data FROM plans').fetchall():
                p = json.loads(row[0])
                if p.get('sessionId') == session:
                    p.update(enabled=False, nextAt=None, revision=p['revision'] + 1, reason='原对话已删除')
                    db.execute('UPDATE plans SET enabled=0,due=NULL,data=? WHERE id=?', (json.dumps(p, ensure_ascii=False), p['id']))
            return dict(id=session, at=at, revision=revision)

    def pending_session_cleanup(self):
        with self.db() as db:
            return [row[0] for row in db.execute('SELECT id FROM deleted_sessions WHERE notice_pending=1')]

    def complete_session_cleanup(self, session):
        with self.db() as db:
            db.execute('UPDATE deleted_sessions SET notice_pending=0 WHERE id=?', (session,))

    def create_goal(self, spec, *, session=None, title=None, plan=None, db=None):
        if db is None:
            with self.db() as conn:
                return self.create_goal(spec, session=session, title=title, plan=plan, db=conn)
        session = session or 'task-' + ident()
        if not SAFE_ID.fullmatch(session):
            raise TaskConflict('无效会话。')
        self._require_session(db, session)
        if db.execute("SELECT 1 FROM goals WHERE session=? AND status NOT IN ('completed','cancelled')", (session,)).fetchone():
            raise TaskConflict('该会话已有目标，请先完成或取消。')
        goal_id = ident()
        from easel.task_stages import prepare_stages
        goal = {**spec, 'id': goal_id, 'stages': prepare_stages(spec, goal_id),
                'sessionId': session, 'title': title or spec['objective'][:50],
                'planId': plan, 'revision': 1, 'stopEpoch': 0, 'status': 'draft', 'phase': 'idle',
                'iterations': 0, 'activeSeconds': 0, 'createdAt': self.clock(), 'checks': [],
                'noProgress': 0, 'reason': '', 'lastFingerprint': None, 'imagesUsed': 0, 'toolsUsed': 0}
        self._goal(db, goal)
        db.execute('INSERT OR IGNORE INTO sessions VALUES(?,?)', (session, json.dumps({
            'id': session, 'title': title or spec['objective'][:50], 'engine': spec.get('engine', 'openclaw'),
            'created': int(self.clock() * 1000), 'messages': []}, ensure_ascii=False)))
        self._event(db, session, 'goal_created', {'goalId': goal['id']})
        scopes = self.path.parent / 'scopes'
        scopes.mkdir(exist_ok=True)
        (scopes / session).touch()
        db.execute('INSERT INTO messages(session,turn,data) VALUES(?,?,?)', (session, 'goal-info-' + goal['id'], json.dumps({
            'role': 'assistant', 'content': '目标已建立：' + goal['objective'], 'turnId': 'goal-info-' + goal['id'], 'taskGoalId': goal['id']}, ensure_ascii=False)))
        return goal

    def get(self, table, key):
        if table not in ('goals', 'runs', 'plans'):
            raise ValueError('invalid table')
        with self.db() as db:
            return self._get(db, table, key)

    def revise_goal(self, key, objective, criteria):
        with self.db() as db:
            g = self._get(db, 'goals', key)
            if g.get('workflow') in ('reviewed-delivery', 'parallel-reviewed-delivery', PLANNED_WORKFLOW) and not any(c['type'] == 'review' for c in criteria):
                raise TaskConflict('审查协作必须保留用户最终质量验收项。')
            if g['status'] in ('active', 'completed', 'cancelled') or db.execute(
                    "SELECT 1 FROM runs WHERE goal=? AND state IN ('running','unconfirmed','queued')", (key,)).fetchone():
                raise TaskConflict('请先停止并等待结算，再修改未完成目标。')
            from easel.task_stages import prepare_stages
            stage_spec = {s['id']: {k: s[k] for k in ('id', 'title', 'roleId', 'objective', 'criteria')}
                          for s in g.get('stages', [])}
            if g.get('workflow') == PLANNED_WORKFLOW:
                self._retire_plan(g)
            g.update(objective=objective, title=objective[:50], criteria=criteria, checks=[], steps=[],
                     stages=prepare_stages({**g, 'stages': list(stage_spec.values())}, g['id']),
                     revision=g['revision'] + 1, stopEpoch=g['stopEpoch'] + 1,
                     phase='idle', noProgress=0, lastFingerprint=None, reviewedTurnId=None, currentTurnId=None,
                     reason='目标已修改，确认后继续；累计限额保留。')
            self._goal(db, g)
            self._event(db, g['sessionId'], 'goal_revised', {'goalId':key, 'revision':g['revision']})
            return g

    def rework_stage(self, key, *, stage_id, revision, request_id, reason):
        """Archive superseded handoffs and prepare an explicit, paused retry.

        No model request, budget reset, file deletion or file restoration occurs.
        The request receipt and new revision commit in the same transaction.
        """
        from easel.image_jobs import ImageJobs
        # Match image submission's lock order (images, then tasks). Keep the
        # image queue stable until the paused revision is committed.
        with ImageJobs(self.outputs).db() as image_db:
            image_db.execute('BEGIN IMMEDIATE')
            return self._rework_stage(key, stage_id=stage_id, revision=revision,
                                      request_id=request_id, reason=reason, image_db=image_db)

    def _rework_stage(self, key, *, stage_id, revision, request_id, reason, image_db):
        with self.db() as db:
            g = self._get(db, 'goals', key)
            self._require_session(db, g['sessionId'])
            request = {'stageId': stage_id, 'revision': revision, 'reason': reason}
            row = db.execute('SELECT data FROM stage_reworks WHERE goal=? AND request=?', (key, request_id)).fetchone()
            if row:
                receipt = json.loads(row[0])
                if receipt['request'] != request:
                    raise TaskConflict('该请求标识已用于不同的重做内容，请刷新后重试。')
                return {'goal': g, 'receipt': receipt, 'replayed': True}
            if g['revision'] != revision:
                raise TaskConflict('目标版本已变化，请刷新并重新确认重做范围。')
            if g['status'] in ('active', 'completed', 'cancelled'):
                raise TaskConflict('请先暂停并等待结算；终态目标请新建目标。')
            if db.execute("SELECT 1 FROM runs WHERE (session=? OR goal=?) AND state IN ('running','unconfirmed','queued')", (g['sessionId'], key)).fetchone() or db.execute(
                    'SELECT 1 FROM chat_leases WHERE session=?', (g['sessionId'],)).fetchone():
                raise TaskConflict('该会话仍有后台运行尚未结算，不能重做阶段。')
            related = {g['sessionId']} | {row[0] for row in db.execute('SELECT DISTINCT session FROM runs WHERE goal=?', (key,))}
            for session in related:
                if image_db.execute("SELECT 1 FROM jobs WHERE scope>=? AND scope<? AND status IN ('queued','running','unconfirmed') LIMIT 1",
                                    (session + ':', session + ';')).fetchone():
                    raise TaskConflict('该会话仍有生图尚未结算，不能重做阶段。')
            stages = g.get('stages', [])
            index = next((i for i, s in enumerate(stages) if s['id'] == stage_id), None)
            if index is None:
                raise TaskConflict('协作阶段不存在。')
            retained = [s for s in stages if s not in affected_stages(g, stage_id)] if parallel(g) else stages[:index]
            required = ancestors(g, stage_id) if parallel(g) else {s['id'] for s in stages[:index]}
            if any(s['status'] != 'completed' for s in stages if s['id'] in required):
                raise TaskConflict('起点前仍有未完成阶段，请从更早的阶段重做。')
            affected = affected_stages(g, stage_id)
            if all(s['status'] == 'pending' for s in affected):
                raise TaskConflict('所选阶段及后续尚未执行，无需重做。')
            required_rounds = 4 if stages[index].get('planGate') else len(affected)
            if g['maxIterations'] - g['iterations'] < required_rounds:
                raise TaskConflict('剩余轮次不足以重做所选阶段及后续；累计预算保留，请新建目标。')
            if g['activeSeconds'] >= g['maxSeconds'] or g['toolsUsed'] >= g['maxTools']:
                raise TaskConflict('已达到累计执行预算，不能通过重做重置；请新建目标。')
            from easel.task_stages import validate_handoffs
            try:
                validate_handoffs(self.outputs, {**g, 'stages': retained})
            except ValueError as exc:
                raise TaskConflict(str(exc)) from None
            receipt = self._archive_stage_rework(db, g, index, request_id, reason)
            self._goal(db, g)
            return {'goal': g, 'receipt': receipt, 'replayed': False}

    def _archive_stage_rework(self, db, g, index, request_id, reason, *, automatic=False):
        """Caller has already established settled resources and retained inputs."""
        stages, revision = g['stages'], g['revision']
        stage_id = stages[index]['id']
        affected = affected_stages(g, stage_id)
        affected_ids = {s['id'] for s in affected}
        receipt = {'id': request_id, 'goalId': g['id'], 'source': 'reviewer' if automatic else 'human',
                   'request': {'stageId': stage_id, 'revision': revision, 'reason': reason},
                   'fromRevision': revision, 'toRevision': revision + 1, 'at': self.clock(),
                   'stages': affected, 'checks': g.get('checks', []), 'steps': g.get('steps', []),
                   'reviewedTurnId': g.get('reviewedTurnId'), 'currentTurnId': g.get('currentTurnId')}
        if stages[index].get('planGate') and g.get('taskPlan'):
            receipt['taskPlan'] = g['taskPlan']
        db.execute('INSERT INTO stage_reworks VALUES(?,?,?)', (g['id'], request_id, json.dumps(receipt, ensure_ascii=False)))
        if stages[index].get('planGate'):
            from easel.task_stages import prepare_stages
            self._retire_plan(g)
            g['stages'] = prepare_stages(g, g['id'])
        else:
            g['stages'] = [{**{k: s[k] for k in ('id', 'title', 'roleId', 'objective', 'criteria', 'role', 'attempts', 'reviewGate', 'dependsOn', 'access', 'groupId', 'groupPath') if k in s},
                           'status': 'pending', 'checks': []} if s['id'] in affected_ids else s for s in stages]
        summary = {k: receipt[k] for k in ('id', 'source', 'fromRevision', 'toRevision', 'at')}
        summary.update(stageId=stage_id, title=stages[index]['title'], reason=reason,
                       affected=[{'id': s['id'], 'title': s['title']} for s in affected])
        g.update(status='active' if automatic else 'paused', phase='queued' if automatic else 'idle',
                 revision=revision + 1, stopEpoch=g['stopEpoch'] + 1,
                 currentStageId=stage_id, currentTurnId=None, reviewedTurnId=None, checks=[], steps=[],
                 noProgress=0, lastFingerprint=None, cancelRequested=False, lastRework=summary,
                 reason=('审查建议返工，下一阶段：' + stages[index]['title']) if automatic else
                        ('已准备从“' + stages[index]['title'] + '”重做，确认后继续；累计预算保留。'))
        self._event(db, g['sessionId'], 'stage_rework', {'goalId': g['id'], **summary})
        return receipt

    @staticmethod
    def _retire_plan(g):
        attempts = g.setdefault('retiredStageAttempts', {})
        for stage in g.get('stages', []):
            attempts[stage['id']] = max(attempts.get(stage['id'], 0), stage.get('attempts', 0))
        g.pop('taskPlan', None)

    def _review_rework(self, db, g, r):
        from easel.task_stages import stage_for_run
        stage = stage_for_run(g, r)
        target = stage['review']['targetStageId']
        index = next(i for i, s in enumerate(g['stages']) if s['id'] == target)
        reason = ''
        if g.get('autoReworksUsed', 0) >= stage['reviewGate']['maxAutoReworks']:
            reason = '已用完自动返工次数，请检查审查意见后人工处理。'
        elif g['maxIterations'] - g['iterations'] < len(affected_stages(g, target)) or g['activeSeconds'] >= g['maxSeconds'] or g['toolsUsed'] >= g['maxTools']:
            reason = '剩余累计预算不足以完成返工和后续阶段，请保留记录并新建目标。'
        if reason:
            stage['status'] = 'blocked'
            g.update(status='blocked', phase='review_rework_limit', reason=reason)
            return
        # read_review already rechecked the current upstream file versions.
        self._archive_stage_rework(db, g, index, 'review-' + r['id'],
                                   '审查建议返工：' + stage['review']['summary'], automatic=True)
        g['autoReworksUsed'] = g.get('autoReworksUsed', 0) + 1

    def rework_receipts(self, key):
        with self.db() as db:
            self._get(db, 'goals', key)
            return [json.loads(row[0]) for row in db.execute(
                'SELECT data FROM stage_reworks WHERE goal=? ORDER BY rowid DESC', (key,))]

    def update_progress(self, session, call, steps):
        from easel.task_rules import GoalProgress
        progress = GoalProgress(steps=steps).model_dump()['steps']
        with self.db() as db:
            row = db.execute("SELECT data FROM runs WHERE session=? AND state='running'", (session,)).fetchone()
            if not row:
                raise TaskConflict('没有可更新的目标运行。')
            r = json.loads(row[0]); g = self._get(db, 'goals', r['goalId'])
            reservation = (r.get('providerRunId') or '') + ':easel_goal_update:' + call
            if not r.get('providerRunId') or not db.execute(
                    'SELECT 1 FROM tool_reservations WHERE goal=? AND call=?', (g['id'], reservation)).fetchone():
                raise TaskConflict('步骤更新没有匹配当前运行的工具准入记录。')
            if g['status'] != 'active' or g['stopEpoch'] != r['stopEpoch'] or g['revision'] != r['revision']:
                raise TaskConflict('目标已停止或修改，拒绝晚到的步骤更新。')
            if parallel(g):
                r['steps'] = progress
                db.execute('UPDATE runs SET data=? WHERE id=?', (json.dumps(r, ensure_ascii=False), r['id']))
                next(s for s in g['stages'] if s['id'] == r['stageId'])['steps'] = progress
            else:
                g['steps'] = progress
            g.update(progressUpdatedAt=self.clock(), progressSource='agent')
            self._goal(db, g)
            self._event(db, g['sessionId'], 'goal_progress', {'goalId':g['id'], 'runId':r['id'], 'steps':progress})
            return {'ok':True, 'goalId':g['id'], 'completed':sum(s['status']=='completed' for s in progress),
                    'total':len(progress), 'qualityApproved':False}

    def block(self, key, reason, phase='admission'):
        with self.db() as db:
            g = self._get(db, 'goals', key)
            if g['status'] == 'active':
                g.update(status='blocked', phase=phase, reason=reason)
                self._goal(db, g)
            return g

    def invalidate_handoff(self, key, reason):
        with self.db() as db:
            g = self._get(db, 'goals', key)
            if g['status'] != 'cancelled':
                if db.execute("SELECT 1 FROM goals WHERE session=? AND id<>? AND status NOT IN ('completed','cancelled')",
                              (g['sessionId'], key)).fetchone():
                    raise TaskConflict('当前会话已有后续目标；历史证据变化不能替换当前目标。')
                g.update(status='blocked', phase='evidence_changed', reason=reason, reviewedTurnId=None)
                self._goal(db, g)
                self._event(db, g['sessionId'], 'handoff_changed', {'goalId': key})
            return g

    @staticmethod
    def _budget_summary(g, reason):
        done = sum(s['status'] == 'completed' for s in g.get('steps', []))
        passed = sum(c.get('state') == 'passed' for c in g.get('checks', []))
        return ('目标已达执行上限，已停止自动推进（这不是完成）。\n'
                f"目标：{g['title']}\n"
                f"用量：{g['iterations']}/{g['maxIterations']}轮 · {int(g['activeSeconds'])}/{g['maxSeconds']}秒 · "
                f"工具{g['toolsUsed']}/{g['maxTools']} · 生图{g['imagesUsed']}/{g['maxImages']}\n"
                f"进度：步骤{done}/{len(g.get('steps', []))}完成 · 验收{passed}/{len(g['criteria'])}通过\n"
                f"阻塞：{reason}\n"
                '下一步：核对验收记录与产物；需要继续时请调整执行上限后新建目标。')

    def _conclude_budget(self, db, g, reason):
        """Limit reached: stop substantive work and leave one honest wrap-up."""
        g.update(status='blocked', phase='budget', reason=reason, cancelRequested=True)
        text = self._budget_summary(g, reason)
        db.execute('INSERT OR REPLACE INTO messages(session,turn,data) VALUES(?,?,?)', (g['sessionId'], 'goal-budget-' + g['id'], json.dumps({
            'role': 'assistant', 'content': text, 'turnId': 'goal-budget-' + g['id'], 'taskGoalId': g['id']}, ensure_ascii=False)))
        self._goal(db, g)
        self._event(db, g['sessionId'], 'goal_budget', {'goalId': g['id'], 'reason': reason})
        return g

    def conclude_budget(self, key, reason):
        with self.db() as db:
            g = self._get(db, 'goals', key)
            if g['status'] != 'active':
                return g
            return self._conclude_budget(db, g, reason)

    def office_context(self, session):
        """Bounded, read-only task context for an exact parent or worker session."""
        if not SAFE_ID.fullmatch(session):
            raise TaskConflict('无效会话。')
        if not self.path.is_file():
            return {'goal': None, 'runs': []}
        with sqlite3.connect(self.path.as_uri() + '?mode=ro', uri=True, timeout=5) as db:
            db.row_factory = sqlite3.Row
            db.execute('BEGIN')
            self._require_session(db, session)
            row = db.execute("SELECT data FROM goals WHERE session=? ORDER BY CASE WHEN status NOT IN ('completed','cancelled') THEN 0 ELSE 1 END,rowid DESC LIMIT 1", (session,)).fetchone()
            if not row:
                run = db.execute('SELECT goal FROM runs WHERE session=? ORDER BY rowid DESC LIMIT 1', (session,)).fetchone()
                row = db.execute('SELECT data FROM goals WHERE id=?', (run['goal'],)).fetchone() if run else None
            if not row:
                return {'goal': None, 'runs': []}
            goal = json.loads(row['data'])
            runs = [json.loads(r['data']) for r in db.execute('SELECT data FROM runs WHERE goal=? AND session NOT IN (SELECT id FROM deleted_sessions) ORDER BY rowid DESC LIMIT 301', (goal['id'],))]
            return {'goal': goal, 'runs': runs[:300], 'truncated': len(runs) > 300}

    def snapshot(self, session=None):
        with self.db() as db:
            where, args = (' WHERE session=?', (session,)) if session else ('', ())
            goals = [json.loads(r[0]) for r in db.execute('SELECT data FROM goals' + where + ' ORDER BY rowid DESC LIMIT 300', args)]
            run_where, run_args = (' WHERE session=? OR goal IN (SELECT id FROM goals WHERE session=?)', (session, session)) if session else ('', ())
            runs = [json.loads(r[0]) for r in db.execute('SELECT data FROM runs' + run_where + ' ORDER BY rowid DESC LIMIT 500', run_args)]
            plans = [json.loads(r[0]) for r in db.execute('SELECT data FROM plans ORDER BY rowid DESC')]
            plans = [p for p in plans if not session or p.get('sessionId') == session][:200]
            deleted = self._deleted_sessions(db)
            removed = {row['id'] for row in deleted}
            for g in goals:
                g['sessionDeleted'] = g['sessionId'] in removed
            # Count durable trigger records, not the capped 100-row display history.
            counts = {r['plan']: r for r in db.execute('''
                SELECT t.plan, COUNT(*) AS triggers, COUNT(t.run) AS launched,
                       SUM(CASE WHEN g.status='active' THEN 1 ELSE 0 END) AS active
                FROM (SELECT plan,run FROM slots UNION ALL
                      SELECT plan,run FROM manual_requests) t
                LEFT JOIN goals g ON g.id=t.run GROUP BY t.plan
            ''')}
            for p in plans:
                count = counts.get(p['id'])
                p.update(triggerCount=count['triggers'] if count else 0,
                         launchedCount=count['launched'] if count else 0,
                         activeCount=count['active'] if count else 0)
                last = p.get('lastResult') or next(iter((p.get('history') or [])[-1:]), None)
                row = db.execute('SELECT data FROM goals WHERE id=?', (last['goalId'],)).fetchone() if last and last.get('goalId') else None
                latest = json.loads(row[0]) if row else None
                p['lastGoal'] = ({**{k: latest.get(k) for k in ('id', 'sessionId', 'status', 'phase', 'reason')},
                                  'sessionDeleted': latest['sessionId'] in removed} if latest else None)
            return {'goals': goals,
                    'plans': plans,
                    'runs': runs,
                    'serverTime': self.clock(), 'deletedSessions': deleted,
                    'revision': db.execute('SELECT COALESCE(MAX(seq),0) FROM events').fetchone()[0],
                    'budgetMode': 'iterations_time_tools_images',
                    'limitations': 'Token及金额不提供硬封顶；子Agent在目标运行中禁用。质量项由用户验收。'}

    def due_plans(self, now):
        # Scheduling must not inherit the management page's history limit.
        with self.db() as db:
            return [json.loads(r[0]) for r in db.execute(
                'SELECT data FROM plans WHERE enabled=1 AND due<=? ORDER BY due', (now,))]

    def keep_awake_enabled(self):
        with self.db() as db:
            row = db.execute("SELECT value FROM settings WHERE key='keepAwake'").fetchone()
            return bool(row and row[0] == 'true')

    def set_keep_awake_enabled(self, enabled):
        with self.db() as db:
            db.execute("INSERT INTO settings(key,value) VALUES('keepAwake',?) "
                       "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       ('true' if enabled else 'false',))
            return enabled

    def session_snapshots(self):
        return self.session_state()['sessions']

    def session_state(self):
        # Hold the transaction while constructing both parts of the read.
        with self.db() as db:
            rows = [json.loads(r[0]) for r in db.execute('SELECT s.data FROM sessions s LEFT JOIN deleted_sessions d ON s.id=d.id WHERE d.id IS NULL ORDER BY s.rowid DESC LIMIT 300')]
            for s in rows:
                s['messages'] = [json.loads(r[0]) for r in db.execute('SELECT data FROM messages WHERE session=? ORDER BY seq', (s['id'],))]
            return {'sessions': rows, 'deletedSessions': self._deleted_sessions(db)}

    def session_work(self, session, include_children=True):
        with self.db() as db:
            return [row[0] for row in db.execute(
                "SELECT turn FROM runs WHERE (session=? OR (? AND goal IN (SELECT id FROM goals WHERE session=?))) AND state IN ('running','unconfirmed') UNION SELECT turn FROM chat_leases WHERE session=?",
                (session, include_children, session, session))]

    def related_sessions(self, session):
        with self.db() as db:
            return sorted({session} | {r[0] for r in db.execute(
                'SELECT DISTINCT r.session FROM runs r JOIN goals g ON r.goal=g.id WHERE g.session=?', (session,))})

    def change_goal(self, key, action):
        with self.db() as db:
            g = self._get(db, 'goals', key)
            if action not in ('pause', 'stop', 'cancel'):
                self._require_session(db, g['sessionId'])
            if g['status'] in ('completed', 'cancelled'):
                if action in ('cancel','stop','pause') and g['status'] == 'cancelled':
                    return g
                raise TaskConflict('终态目标保留历史，不能修改执行状态；请新建目标。')
            if action in ('pause', 'stop', 'cancel'):
                g.update(status='cancelled' if action == 'cancel' else 'paused', reason='已取消' if action == 'cancel' else '已暂停自动推进')
                g['stopEpoch'] += 1
                # Queued work has not reached the provider, so cancellation is safe.
                for row in db.execute("SELECT * FROM runs WHERE goal=? AND state='queued'", (key,)).fetchall():
                    r = json.loads(row['data']); r.update(state='stopped', finishedAt=self.clock())
                    db.execute("UPDATE runs SET state='stopped',data=? WHERE id=?", (json.dumps(r), row['id']))
                g['cancelRequested'] = True
            elif action in ('start', 'resume'):
                if g['status'] == 'active':
                    return g
                if g['status'] in ('completed', 'cancelled'):
                    raise TaskConflict('终态目标不能重新启动，请新建目标。')
                if db.execute("SELECT 1 FROM runs WHERE goal=? AND state IN ('running','unconfirmed')", (key,)).fetchone():
                    raise TaskConflict('后台运行尚未结算；先核实或停止，不能重复提交。')
                if g['iterations'] >= g['maxIterations'] or g['activeSeconds'] >= g['maxSeconds']:
                    raise TaskConflict('已达到执行上限；请保留记录并新建有明确预算的目标。')
                if g.get('stages') and all(s['status'] == 'completed' for s in g['stages']):
                    g['stages'][-1]['status'] = 'pending'
                    g['steps'] = []
                g.update(status='active', phase='queued', reason='', cancelRequested=False)
            else:
                raise TaskConflict('不支持的目标操作。')
            self._goal(db, g); self._event(db, g['sessionId'], 'goal_' + action, {'goalId': key})
            return g

    def claim(self, owner, goal_id=None):
        with self.db() as db:
            for row in db.execute("SELECT * FROM runs WHERE state='running' AND lease<?", (self.clock(),)).fetchall():
                r = json.loads(row['data']); g = self._get(db, 'goals', row['goal'])
                # Even before acknowledgement, the previous process may have sent it.
                r.update(state='unconfirmed', reason='执行进程失联，未自动重发。')
                from easel.task_stages import stage_for_run
                if stage := stage_for_run(g, r):
                    stage['status'] = 'unconfirmed'
                db.execute("UPDATE runs SET state='unconfirmed',data=? WHERE id=?", (json.dumps(r), r['id']))
                if g['status'] not in ('paused', 'cancelled'):
                    g.update(status='blocked', phase='unconfirmed', reason=r['reason'])
                self._goal(db, g)
            for row in db.execute("SELECT data FROM goals WHERE status='active' ORDER BY rowid").fetchall():
                g = json.loads(row[0]); session = g['sessionId']
                if goal_id is not None and g['id'] != goal_id:
                    continue
                live = [json.loads(row[0]) for row in db.execute("SELECT data FROM runs WHERE goal=? AND state IN ('running','unconfirmed')", (g['id'],))]
                if parallel(g):
                    candidates = admissible_stages(g, live)
                    if len(live) >= 2 or any(r['state'] == 'unconfirmed' for r in live) or not candidates:
                        continue
                elif db.execute("SELECT 1 FROM runs WHERE session=? AND state IN ('running','unconfirmed')", (session,)).fetchone():
                    continue
                if db.execute('SELECT 1 FROM chat_leases WHERE session=?', (session,)).fetchone():
                    continue
                row = db.execute("SELECT * FROM runs WHERE goal=? AND state='queued'", (g['id'],)).fetchone()
                if row:
                    r = json.loads(row['data'])
                else:
                    if g['iterations'] >= g['maxIterations'] or g['activeSeconds'] >= g['maxSeconds']:
                        self._conclude_budget(db, g, '已达到目标轮次或时长上限。'); continue
                    r = {'id': ident(), 'goalId': g['id'], 'sessionId': session,
                         'turnId': 'goal-' + ident(), 'iteration': g['iterations'] + 1,
                         'revision': g['revision'], 'stopEpoch': g['stopEpoch'], 'createdAt': self.clock()}
                from easel.task_stages import current_stage
                from easel.task_rules import check_goal
                stage = candidates[0] if parallel(g) else current_stage(g)
                if parallel(g):
                    remaining = g['maxSeconds'] - g['activeSeconds'] - sum(item.get('maxRunSeconds', 0) for item in live)
                    if remaining < 1:
                        self._conclude_budget(db, g, '可用时长预算已不足，未派发新的并行阶段。'); continue
                    slots = 1 if stage.get('access') == 'write' else min(2 - len(live), len(candidates))
                    r.update(sessionId=worker_session(g, stage), parentSessionId=session,
                             maxRunSeconds=remaining / slots, steps=[])
                    scopes = self.path.parent / 'scopes'
                    scopes.mkdir(exist_ok=True)
                    (scopes / r['sessionId']).touch()
                if stage:
                    stage.update(status='running', attempts=stage.get('attempts', 0) + 1, turnId=r['turnId'])
                    stage['baseline'] = check_goal(self.outputs, stage, '')[0]
                    r.update(stageId=stage['id'], roleId=stage['roleId'], role=stage['role'])
                    g['currentStageId'] = stage['id']
                    if stage.get('planGate'):
                        from easel.task_planning import plan_contract
                        r['planContract'] = plan_contract(g, r)
                    if stage.get('reviewGate'):
                        from easel.stage_review import review_contract
                        r['reviewContract'] = review_contract(g, r, outputs=self.outputs)
                r.update(state='running', owner=owner, startedAt=self.clock(), modelRef=g['modelRef'], workTools=0)
                if g.get('lastRework') and g['lastRework']['toRevision'] == g['revision']:
                    r['reworkId'] = g['lastRework']['id']
                db.execute('INSERT OR REPLACE INTO runs VALUES(?,?,?,?,?,?,?,?,?)',
                           (r['id'], g['id'], r['sessionId'], r['turnId'], 'running', owner, self.clock() + 90, 1, json.dumps(r)))
                g.update(iterations=r['iteration'], phase='running', currentTurnId=r['turnId'])
                self._goal(db, g)
                return g, r

    def heartbeat(self, run, owner):
        with self.db() as db:
            return db.execute("UPDATE runs SET lease=? WHERE id=? AND owner=? AND state='running'",
                              (self.clock() + 90, run, owner)).rowcount == 1

    def bind_provider(self, session, turn, provider):
        with self.db() as db:
            row = db.execute("SELECT data FROM runs WHERE session=? AND turn=? AND state='running'", (session, turn)).fetchone()
            if not row:
                return False
            r = json.loads(row[0])
            if r.get('providerRunId') and r['providerRunId'] != provider:
                raise TaskConflict('运行器返回了不同的运行身份，未替换已确认记录。')
            r['providerRunId'] = provider
            db.execute('UPDATE runs SET data=? WHERE id=?', (json.dumps(r), r['id']))
            return True

    def running(self):
        with self.db() as db:
            return [json.loads(r[0]) for r in db.execute("SELECT data FROM runs WHERE state IN ('running','unconfirmed')")]

    def is_goal_turn(self, session, turn):
        with self.db() as db:
            return db.execute("SELECT 1 FROM runs WHERE session=? AND turn=? AND state='running'", (session, turn)).fetchone() is not None

    def run_context(self, session, turn, *, current=False):
        """Resolve exact host-owned identities; callers never supply a goal ID."""
        with self.db() as db:
            row = db.execute('SELECT data FROM runs WHERE session=? AND turn=?', (session, turn)).fetchone()
            if not row:
                return None
            r = json.loads(row[0]); g = self._get(db, 'goals', r['goalId'])
            if current:
                self._require_session(db, session)
                if (r['state'] != 'running' or g['status'] != 'active'
                        or r['stopEpoch'] != g['stopEpoch'] or r['revision'] != g['revision']):
                    raise TaskConflict('目标已停止、修改或尚未确认，拒绝新的操作。')
            return g, r

    def observe_codex_tool(self, session, turn, provider, call, tool):
        """Count native events, including late/parallel excess; this is not admission."""
        with self.db() as db:
            row = db.execute('SELECT data FROM runs WHERE session=? AND turn=?', (session, turn)).fetchone()
            if not row or not provider or not call:
                raise TaskConflict('缺少可核验的Codex运行身份。')
            r = json.loads(row[0]); g = self._get(db, 'goals', r['goalId'])
            if (g.get('engine') != 'codex' or g.get('toolBudgetMode') != 'observed'
                    or r.get('providerRunId') != provider or r['state'] != 'running'):
                raise TaskConflict('Codex工具事件与当前运行不匹配。')
            reservation = provider + ':native:' + call
            if not db.execute('SELECT 1 FROM tool_reservations WHERE goal=? AND call=?', (g['id'], reservation)).fetchone():
                db.execute('INSERT INTO tool_reservations VALUES(?,?)', (g['id'], reservation))
                g['toolsUsed'] += 1
                r['workTools'] = r.get('workTools', 0) + 1
                db.execute('UPDATE runs SET data=? WHERE id=?', (json.dumps(r), r['id']))
                if g['status'] == 'active' and g['toolsUsed'] >= g['maxTools']:
                    self._conclude_budget(db, g, '原生工具已达到观察上限，已请求停止；已发出或并行工具可能超额。')
                else:
                    self._goal(db, g)
            return {'stop': g['status'] != 'active' or g['stopEpoch'] != r['stopEpoch'], 'observed': g['toolsUsed']}

    def finish(self, run, *, owner, text='', state='completed', checks=None, fingerprint=None, reason='', resource_settled=True, stage_checks=None, message_metadata=None):
        with self.db() as db:
            r = self._get(db, 'runs', run)
            if r.get('owner') != owner:
                raise TaskConflict('运行所有权已变化，拒绝过期结果。')
            if r['state'] not in ('running', 'unconfirmed'):
                return self._get(db, 'goals', r['goalId'])
            g = self._get(db, 'goals', r['goalId'])
            r.update(state=state if resource_settled else 'unconfirmed', text=text[-200000:],
                     finishedAt=self.clock(), checks=checks or [], stageChecks=stage_checks or [], reason=reason)
            db.execute('UPDATE runs SET state=?,data=? WHERE id=?', (r['state'], json.dumps(r, ensure_ascii=False), run))
            db.execute('INSERT OR REPLACE INTO messages(session,turn,data) VALUES(?,?,?)', (g['sessionId'], r['turnId'], json.dumps({
                'role': 'assistant', 'content': text or reason or ('本轮被中断，目标已暂停，可从当前记录继续。' if state == 'stopped' else '本轮已结束，请查看验收与产物记录。'), 'turnId': r['turnId'],
                **{k:v for k,v in (message_metadata or {}).items() if k in ('thinking', 'thinkingStatus', 'startedAt', 'elapsedMs', 'stopped')},
                'requestedModelRef': r.get('modelRef'), 'roleId': r.get('roleId'),
                'taskStageId': r.get('stageId'), 'taskRunId': r['id'], 'sourceSessionId': r['sessionId']}, ensure_ascii=False)))
            g['activeSeconds'] += max(0, self.clock() - r.get('countedAt', r['startedAt']))
            r['countedAt'] = self.clock()
            db.execute('UPDATE runs SET data=? WHERE id=?', (json.dumps(r, ensure_ascii=False), run))
            if checks is not None:
                g['checks'] = checks
            from easel.task_stages import settle_stage, stage_for_run
            stage = stage_for_run(g, r)
            stale = g['status'] != 'active' or g['stopEpoch'] != r['stopEpoch'] or g['revision'] != r['revision']
            if stage and (not resource_settled or state != 'completed' or stale):
                stage.update(status='unconfirmed' if not resource_settled else 'pending' if state == 'stopped' else 'blocked',
                             turnId=r['turnId'])
            deleted = db.execute('SELECT 1 FROM deleted_sessions WHERE id=?', (g['sessionId'],)).fetchone()
            if deleted:
                g.update(phase='unconfirmed' if not resource_settled else 'idle',
                         reason='原对话已删除，后台停止待确认' if not resource_settled else '原对话已删除')
            elif not resource_settled:
                # Resource uncertainty must not undo a user's cancellation or
                # erase the budget wrap-up. Both still fence later stages.
                if g['status'] not in ('paused', 'cancelled'):
                    g['status'] = 'blocked'
                if g['phase'] != 'budget':
                    g['phase'] = 'unconfirmed'
                g['reason'] = reason or '外部资源未结算，未自动重发。'
            elif g['status'] != 'active' or g['stopEpoch'] != r['stopEpoch'] or g['revision'] != r['revision']:
                # A late result cannot restart a paused/replaced goal; an already
                # written budget wrap-up keeps its phase.
                if g['phase'] != 'budget' and not (parallel(g) and g['status'] == 'blocked' and g['phase'] != 'unconfirmed'):
                    recovered_failure = g['status'] == 'blocked' and g['phase'] == 'unconfirmed' and state == 'failed'
                    g['phase'] = 'idle'
                    if recovered_failure:
                        g.update(phase='run_failed', reason=reason or '后台已确认结束，本轮未正常完成。')
                    elif g.get('cancelRequested') and g['status'] in ('paused', 'cancelled'):
                        g['reason'] = '已取消' if g['status'] == 'cancelled' else '已暂停自动推进'
            elif state == 'stopped':
                # Interruptions pause the objective; records stay valid for resume.
                g.update(status='paused', phase='idle', reason=reason or '本轮被中断，目标已暂停；继续时从当前记录恢复。')
            elif state != 'completed':
                g.update(status='blocked', phase='run_failed', reason=reason or '本轮未正常完成，请检查记录。')
            elif g.get('stages') and not settle_stage(g, r, text, stage_checks, self.clock(), outputs=self.outputs):
                if g['phase'] == 'stage_rework':
                    self._review_rework(db, g, r)
            elif not valid_checks(g, checks) or any(c['state'] == 'error' for c in checks):
                g.update(status='blocked', phase='verification_error', reason='证据核验异常或验收项不完整，已停止自动推进。')
            elif any(c['type'] == 'review' and c['state'] == 'passed' for c in checks) and g.get('reviewedTurnId') != r['turnId']:
                g.update(status='blocked', phase='verification_error', reason='缺少当前轮次的用户质量确认，未完成目标。')
            elif any(s['status'] == 'blocked' for s in g.get('steps', [])):
                blocked = next(s for s in g['steps'] if s['status'] == 'blocked')
                g.update(status='blocked', phase='waiting_input', reason=blocked.get('detail') or blocked['title'])
            elif checks and all(c['state'] == 'passed' for c in checks) and not any(s['status'] != 'completed' for s in g.get('steps', [])):
                g.update(status='completed', phase='idle', reason='所有验收项通过。')
            elif checks and all(c['state'] == 'passed' or (c['type'] == 'review' and c['state'] == 'pending') for c in checks) and not any(s['status'] != 'completed' for s in g.get('steps', [])):
                g.update(status='blocked', phase='review', reason='自动检查已结束，等待用户验收。')
            elif g.get('stages'):
                g.update(status='blocked', phase='final_checks', reason='阶段交接已结束，但最终验收条件未通过；检查结果后可继续最后阶段。')
            else:
                g['noProgress'] = g['noProgress'] + 1 if g.get('lastFingerprint') == fingerprint else 0
                g['lastFingerprint'] = fingerprint
                g.update(phase='queued', reason='继续处理未通过的验收项。')
                # Count trusted admissions, not model-reported activity. Old
                # runs without this field remain unknown rather than zero.
                if r['iteration'] > 1 and r.get('workTools') == 0:
                    g.update(status='blocked', phase='no_progress', reason='续跑轮未调用工作工具，已停止自动推进；请检查材料、工具能力或调整目标后继续。')
                elif g['noProgress'] >= 2:
                    g.update(status='blocked', phase='no_progress', reason='连续两轮没有新的有效证据，已停止自动推进。')
            self._goal(db, g); self._event(db, g['sessionId'], 'run_settled', {'runId': run, 'status': g['status']})
            if g['status'] in ('completed', 'blocked'):
                from easel.notifications import NotificationStore
                try:
                    NotificationStore(self.outputs).add([{'id':f"goal:{g['id']}:{r['id']}:{g['status']}",
                        'message': ('目标已通过验收' if g['status'] == 'completed' else '目标需要处理') + ' · ' + g['title'][:100],
                        'tone': 'success' if g['status'] == 'completed' else 'info', 'at':self.clock()*1000,
                        'target':{'page':'chat','sessionId':g['sessionId']}}])
                except (OSError, sqlite3.Error, ValueError):
                    pass  # Notification availability must not roll back run settlement.
            return g

    def apply_checks(self, key, checks, *, review=None):
        with self.db() as db:
            g = self._get(db, 'goals', key)
            self._require_session(db, g['sessionId'])
            if db.execute("SELECT 1 FROM runs WHERE goal=? AND state IN ('running','unconfirmed')", (key,)).fetchone():
                raise TaskConflict('请等待后台结算再验收。')
            if g['status'] == 'cancelled':
                raise TaskConflict('已取消目标保留历史，不能重新验收。')
            if any(s['status'] != 'completed' for s in g.get('stages', [])):
                raise TaskConflict('协作阶段尚未完成，不能提前验收整个目标。')
            if db.execute("SELECT 1 FROM goals WHERE session=? AND id<>? AND status NOT IN ('completed','cancelled')", (g['sessionId'], key)).fetchone():
                raise TaskConflict('当前会话已有后续目标，历史目标不能改变当前执行状态。')
            row = db.execute('SELECT data FROM runs WHERE goal=? AND turn=?', (key, g.get('currentTurnId'))).fetchone()
            r = json.loads(row[0]) if row else None
            if not r or r['state'] != 'completed' or r['revision'] != g['revision']:
                raise TaskConflict('仅能验收当前版本中成功结束的轮次；失败或停止的记录请先处理并继续目标。')
            if review and review != r['turnId']:
                raise TaskConflict('质量确认与当前轮次不匹配，请重新查看结果。')
            if not valid_checks(g, checks):
                raise TaskConflict('验收项不完整或不匹配，未完成目标。')
            errored = any(c['state'] == 'error' for c in checks)
            if review and not errored:
                g['reviewedTurnId'] = review
            if not errored and any(c['type'] == 'review' and c['state'] == 'passed' for c in checks) and g.get('reviewedTurnId') != r['turnId']:
                raise TaskConflict('缺少当前轮次的用户质量确认，未完成目标。')
            g['checks'] = checks
            if errored:
                g.update(status='blocked', phase='verification_error', reason='证据核验异常，未完成目标；请修复后重新核验。')
                g.pop('reviewedTurnId', None)
            elif checks and all(c['state'] == 'passed' for c in checks) and g.get('currentTurnId') and not any(s['status'] != 'completed' for s in g.get('steps', [])):
                g.update(status='completed', phase='idle', reason='所有验收项通过。')
            elif g['status'] == 'completed':
                g.update(status='blocked', phase='evidence_changed', reason='产物证据已变化，需要重新验收。')
            elif checks and g.get('currentTurnId') and all(c['state'] == 'passed' or (c['type'] == 'review' and c['state'] == 'pending') for c in checks) and not any(s['status'] != 'completed' for s in g.get('steps', [])):
                g.update(status='blocked', phase='review', reason='自动检查已结束，等待用户验收。')
            self._goal(db, g)
            return g

    def chat_lease(self, session):
        """Return the exact reservation, including expired rows, for reconciliation."""
        with self.db() as db:
            row = db.execute('SELECT turn FROM chat_leases WHERE session=?', (session,)).fetchone()
            return row[0] if row else None

    def reserve_chat(self, session, turn):
        with self.db() as db:
            self._require_session(db, session)
            if db.execute("SELECT 1 FROM runs WHERE (session=? OR goal IN (SELECT id FROM goals WHERE session=?)) AND state IN ('queued','running','unconfirmed')", (session, session)).fetchone():
                raise TaskConflict('目标轮次正在运行或等待结算，本条消息尚未发送；请稍候，或先在目标面板暂停。')
            row = db.execute('SELECT turn FROM chat_leases WHERE session=?', (session,)).fetchone()
            if row:
                raise TaskConflict('该会话仍有运行，请等待或停止。')
            # Human input takes priority without cancelling the goal: holding the
            # chat lease defers continuation to the next idle safe boundary.
            db.execute('INSERT OR REPLACE INTO chat_leases VALUES(?,?,?)', (session, turn, self.clock() + 7200))

    def release_chat(self, session, turn):
        with self.db() as db:
            db.execute('DELETE FROM chat_leases WHERE session=? AND turn=?', (session, turn))

    def pending_chat(self, session):
        """Elapsed local time is not evidence that an external run stopped."""
        with self.db() as db:
            row = db.execute('SELECT turn FROM chat_leases WHERE session=?', (session,)).fetchone()
            return row[0] if row else None

    def save_plan(self, data, next_at, key=None):
        with self.db() as db:
            self._require_session(db, data.get('sessionId'))
            previous = self._get(db, 'plans', key) if key else None
            if previous and previous['enabled']:
                raise TaskConflict('编辑前先暂停计划，当前运行会保留。')
            p = {**data, 'id': key or ident(), 'nextAt': next_at, 'createdAt': previous['createdAt'] if previous else self.clock(),
                 'revision': (previous['revision'] + 1) if previous else 1, 'lastResult': previous.get('lastResult') if previous else None,
                 'history': previous.get('history', []) if previous else []}
            db.execute('INSERT OR REPLACE INTO plans VALUES(?,?,?,?)', (p['id'], int(p['enabled']), p['nextAt'], json.dumps(p, ensure_ascii=False)))
            return p

    def trigger_plan(self, key, *, scheduled_at=None, request=None, next_at=None, missed=False, effective_at=None):
        with self.db() as db:
            p = self._get(db, 'plans', key)
            self._require_session(db, p.get('sessionId'))
            if scheduled_at is not None:
                if not p['enabled'] or p['nextAt'] != scheduled_at:
                    return None
                if db.execute('SELECT 1 FROM slots WHERE plan=? AND at=?', (key, scheduled_at)).fetchone():
                    return None
            elif request:
                found = db.execute('SELECT run FROM manual_requests WHERE plan=? AND request=?', (key, request)).fetchone()
                if found:
                    return None
            session = p.get('sessionId') or 'task-' + ident()
            occupied = db.execute("SELECT 1 FROM goals WHERE session=? AND status NOT IN ('completed','cancelled')", (session,)).fetchone()
            reason = '错过执行窗口，已跳过。' if missed else '绑定会话已有目标，本次跳过。' if occupied else ''
            if scheduled_at is None and occupied:
                raise TaskConflict(reason)
            goal = None if reason else self.create_goal(p['goal'], session=session, title=p['title'], plan=key, db=db)
            if goal:
                goal.update(status='active', phase='queued'); self._goal(db, goal)
            if scheduled_at is not None:
                db.execute('INSERT INTO slots VALUES(?,?,?)', (key, scheduled_at, goal['id'] if goal else None))
                p['nextAt'] = next_at
                p['enabled'] = next_at is not None
            else:
                db.execute('INSERT INTO manual_requests VALUES(?,?,?)', (key, request, goal['id'] if goal else None))
            p['lastResult'] = {'at': self.clock(), 'scheduledAt': effective_at if effective_at is not None else scheduled_at,
                               'missedSince': scheduled_at if effective_at is not None and effective_at != scheduled_at else None,
                               'trigger': 'schedule' if scheduled_at is not None else 'manual',
                               'status': 'skipped' if reason else 'queued', 'reason': reason,
                               'goalId': goal['id'] if goal else None, 'sessionId': session if goal else None}
            history = (p.get('history') or []) + [p['lastResult']]
            p['history'] = history[-100:]
            db.execute('UPDATE plans SET enabled=?,due=?,data=? WHERE id=?', (int(p['enabled']), p['nextAt'], json.dumps(p, ensure_ascii=False), key))
            return goal

    def set_plan_enabled(self, key, enabled, next_at):
        with self.db() as db:
            p = self._get(db, 'plans', key)
            if enabled:
                self._require_session(db, p.get('sessionId'))
            p.update(enabled=enabled, nextAt=next_at)
            db.execute('UPDATE plans SET enabled=?,due=?,data=? WHERE id=?', (int(enabled), next_at, json.dumps(p, ensure_ascii=False), key))
            return p

    def reserve_image(self, session, turn, request, count=1):
        request = turn + ':' + request
        with self.db() as db:
            row = db.execute('SELECT goal FROM runs WHERE session=? AND turn=?', (session, turn)).fetchone()
            if not row:
                return
            g = self._get(db, 'goals', row[0])
            if db.execute('SELECT 1 FROM image_reservations WHERE goal=? AND request=?', (g['id'], request)).fetchone():
                return
            if g['status'] != 'active' or g['imagesUsed'] + count > g['maxImages']:
                raise TaskConflict('目标已暂停或达到图片数量上限；未提交新的生图请求。')
            db.execute('INSERT INTO image_reservations VALUES(?,?)', (g['id'], request))
            g['imagesUsed'] += count
            self._goal(db, g)

    def image_allowed(self, session, turn):
        with self.db() as db:
            if db.execute('SELECT 1 FROM deleted_sessions WHERE id=?', (session,)).fetchone():
                return False
            row = db.execute('SELECT goal,state FROM runs WHERE session=? AND turn=?', (session, turn)).fetchone()
            if not row:
                return True
            g = self._get(db, 'goals', row['goal'])
            return g['status'] == 'active' and row['state'] == 'running'

    def guard(self, session, provider_run, call, tool):
        """Atomic before-tool admission, called by the native Gateway hook."""
        with self.db() as db:
            if db.execute('SELECT 1 FROM deleted_sessions WHERE id=?', (session,)).fetchone():
                return {'allowed': False, 'reason': '原对话已删除，未派发新的操作。'}
            rows = db.execute('SELECT data FROM runs WHERE session=? ORDER BY rowid DESC', (session,)).fetchall()
            runs = [json.loads(row[0]) for row in rows]
            known = next((r for r in runs if provider_run and r.get('providerRunId') == provider_run), None)
            r = known or next((r for r in runs if r['state'] in ('running', 'unconfirmed')), None)
            if not r and runs and not db.execute('SELECT 1 FROM chat_leases WHERE session=? AND until>?', (session, self.clock())).fetchone():
                return {'allowed': False, 'reason': '目标轮次已经结束，未准入新的工具调用。'}
            if not r:
                return {'allowed': True}
            g = self._get(db, 'goals', r['goalId'])
            if not provider_run or not call or r['state'] != 'running' or g['status'] != 'active' or r['stopEpoch'] != g['stopEpoch']:
                return {'allowed': False, 'reason': '目标已停止、状态未确认或调用缺少可核验身份。'}
            if r.get('providerRunId') != provider_run:
                return {'allowed': False, 'reason': '目标运行身份不匹配。'}
            if tool in ('sessions_spawn', 'spawn_agent', 'subagents', 'cron', 'gateway', 'sessions_send'):
                g.update(status='blocked', reason='目标尝试了未授权的派生或调度操作，已暂停。', phase='tool_policy'); self._goal(db, g)
                return {'allowed': False, 'reason': '目标首版不允许派生 Agent、创建嵌套计划或修改网关。'}
            if self.clock() - r['startedAt'] >= min(r.get('maxRunSeconds', g['maxSeconds']), g['maxSeconds'] - g['activeSeconds']):
                return {'allowed': False, 'reason': '目标执行时长已达上限。'}
            reservation = provider_run + ':' + tool + ':' + call
            if db.execute('SELECT 1 FROM tool_reservations WHERE goal=? AND call=?', (g['id'], reservation)).fetchone():
                return {'allowed': True}
            if g['toolsUsed'] >= g['maxTools']:
                self._conclude_budget(db, g, '工具调用已达到目标上限，正在停止。')
                return {'allowed': False, 'reason': '目标工具调用已达上限。'}
            db.execute('INSERT INTO tool_reservations VALUES(?,?)', (g['id'], reservation))
            if tool not in ('easel_goal_update', 'easel_task_guard', 'easel_plan_update'):
                r['workTools'] = r.get('workTools', 0) + 1
                db.execute('UPDATE runs SET data=? WHERE id=?', (json.dumps(r), r['id']))
            g['toolsUsed'] += 1; self._goal(db, g)
            return {'allowed': True}
