"""Read current saved evidence without importing the Web server or running models."""
import json
import re
import sqlite3
import hashlib
from pathlib import Path
from easel.analysis_evidence import account_material_hash


class UnsettledSource(ValueError):
    pass


def settled_analysis_turn(outputs, ledger, session, turn, markdown):
    """Verify the exact saved turn; never consult only a newer session result."""
    database = ledger / 'ledger.sqlite3'
    if database.is_file():
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
            row = db.execute('SELECT data FROM runs WHERE turn=?', (turn,)).fetchone()
        if row:
            run = json.loads(row[0])
            if (run.get('sessionId') != session or run.get('status') != 'completed'
                    or run.get('settled') is not True or run.get('error') or run.get('stopReason')):
                raise UnsettledSource('该轮运行账本尚未确认正常完成，候选提取延后')
    paths = []
    if re.fullmatch(r'[A-Za-z0-9_.-]{1,160}', turn):
        paths.append(ledger / 'jobs' / f'{turn}.snapshot.json')
    paths.append(ledger / f'web_{session}.json')
    paths.append(outputs / '_codex' / hashlib.sha256(session.encode()).hexdigest()
                 / 'turns' / (hashlib.sha256(turn.encode()).hexdigest() + '.json'))
    for path in paths:
        if not path.is_file():
            continue
        snapshot = json.loads(path.read_text(encoding='utf-8'))
        if snapshot.get('turn_id') != turn or snapshot.get('session_id', snapshot.get('sessionId')) != session:
            continue
        completed = snapshot.get('clean_end') is True or snapshot.get('outcome') == 'completed'
        if (snapshot.get('status') != 'done' or not completed or snapshot.get('error')
                or snapshot.get('stopped') or snapshot.get('stop_reason') == 'user_stopped'):
            raise UnsettledSource('原分析轮次未确认正常完成，报告已保留，候选提取延后')
        if snapshot.get('text', '').strip() != markdown.strip():
            raise UnsettledSource('已保存报告与该轮最终正文不同，未自动提取候选')
        return
    raise UnsettledSource('原分析轮次缺少可核对的终态，报告已保留，候选提取延后')


def analysis_source(outputs, binding_id, ledger=None, *, require_settled=False):
    from easel.profile_memory import digest
    outputs = Path(outputs)
    ledger = Path(ledger or outputs / '_sessions')
    path = outputs / '_analytics/workbench/content-analysis.sqlite3'
    if not path.is_file():
        raise LookupError('原分析来源不存在')
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        table = db.execute("SELECT 1 FROM sqlite_master WHERE name='analysis_conversations'").fetchone()
        row = db.execute('SELECT data FROM analysis_conversations WHERE id=?', (str(binding_id),)).fetchone() if table else None
        if not row:
            raise LookupError('原分析来源不存在')
        binding = json.loads(row[0])
        session = binding['sessionId']
        codex = outputs / '_codex' / hashlib.sha256(session.encode()).hexdigest() / 'session.json'
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', session) or not ((ledger / f'web_{session}.json').is_file() or codex.is_file()):
            raise LookupError('原分析对话已删除或不可用')
        selected = [json.loads(row[0]) for row in db.execute('SELECT data FROM contents WHERE platform=? AND account_id=?', (binding['platform'], binding['accountId']))]
        selected = [item for item in selected if item['id'] in binding['contentIds']]
        if not binding.get('result') or len(selected) != len(binding['contentIds']) or account_material_hash(selected) != binding['sourceHash']:
            raise ValueError('分析材料已改变或尚未回填结果')
    result = binding['result']
    tasks = outputs / '_automation/tasks.sqlite3'
    if tasks.is_file():
        with sqlite3.connect(tasks.as_uri() + '?mode=ro', uri=True) as db:
            table = db.execute("SELECT 1 FROM sqlite_master WHERE name='deleted_sessions'").fetchone()
            if table and db.execute('SELECT 1 FROM deleted_sessions WHERE id=?', (session,)).fetchone():
                raise LookupError('原分析对话已删除')
    if require_settled:
        settled_analysis_turn(outputs, ledger, session, result['turnId'], result['markdown'])
    return {'type': 'analysis', 'bindingId': binding['id'], 'platform': binding['platform'],
            'profileName': binding.get('persona', ''), 'profileId': binding.get('personaId'),
            'accountId': binding['accountId'], 'sessionId': session, 'turnId': result['turnId'],
            'contentIds': binding['contentIds'], 'sampleCount': len(binding['contentIds']),
            'periods': sorted({item['period'] for item in selected if item.get('period')}),
            'sourceHash': digest([binding['sourceHash'], result['markdown']]), 'capturedAt': result['at'],
            'markdown': result['markdown'], 'limitation': '分析结论为假设，发布事实不代表内容效果；缺少可比窗口时不能做因果归因。'}
