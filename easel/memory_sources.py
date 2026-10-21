"""Read current saved evidence without importing the Web server or running models."""
import json
import re
import sqlite3
from pathlib import Path
from easel.analysis_evidence import account_material_hash


def analysis_source(outputs, binding_id, ledger=None):
    from easel.profile_memory import digest
    outputs = Path(outputs)
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
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', session) or not (Path(ledger or outputs / '_sessions') / f'web_{session}.json').is_file():
            raise LookupError('原分析对话已删除或不可用')
        selected = [json.loads(row[0]) for row in db.execute('SELECT data FROM contents WHERE platform=? AND account_id=?', (binding['platform'], binding['accountId']))]
        selected = [item for item in selected if item['id'] in binding['contentIds']]
        if not binding.get('result') or len(selected) != len(binding['contentIds']) or account_material_hash(selected) != binding['sourceHash']:
            raise ValueError('分析材料已改变或尚未回填结果')
    result = binding['result']
    return {'type': 'analysis', 'bindingId': binding['id'], 'platform': binding['platform'],
            'accountId': binding['accountId'], 'sessionId': session, 'turnId': result['turnId'],
            'contentIds': binding['contentIds'], 'sampleCount': len(binding['contentIds']),
            'periods': sorted({item['period'] for item in selected if item.get('period')}),
            'sourceHash': digest([binding['sourceHash'], result['markdown']]), 'capturedAt': result['at'],
            'markdown': result['markdown'], 'limitation': '分析结论为假设，发布事实不代表内容效果；缺少可比窗口时不能做因果归因。'}
