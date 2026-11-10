"""Persistent user edits of installed skill bodies; package files stay intact."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time

MAX_BODY = 100_000


def source_body(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ValueError('技能原文不可用，请重新读取。')
    raw = path.read_bytes()
    text = raw.decode('utf-8-sig')
    lines = text.splitlines()
    if lines and lines[0].strip() == '---':
        for index in range(1, len(lines)):
            if lines[index].strip() == '---':
                text = '\n'.join(lines[index + 1:]).strip()
                break
    return text, hashlib.sha256(raw).hexdigest()


class SkillPrompts:
    def __init__(self, data):
        self.path = Path(data) / 'skill-prompts.sqlite3'

    @contextmanager
    def db(self):
        if self.path.is_symlink():
            raise ValueError('技能保存位置无效。')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.execute('CREATE TABLE IF NOT EXISTS prompts(name TEXT PRIMARY KEY, body TEXT, revision INTEGER, updated REAL)')
            db.execute('CREATE TABLE IF NOT EXISTS history(name TEXT, revision INTEGER, body TEXT, updated REAL, PRIMARY KEY(name,revision))')
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def name(name):
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}', name):
            raise ValueError('技能名称无效。')
        return name

    @staticmethod
    def snapshot(name, original, source_hash, row):
        body = row['body'] if row else original
        revision = row['revision'] if row else 0
        token = hashlib.sha256(json.dumps([name, source_hash, revision, body], ensure_ascii=False).encode()).hexdigest()
        return {'body': body, 'promptRevision': token, 'promptCustomized': body != original,
                'promptSavedAt': row['updated'] if row else None}

    def read(self, name, source):
        name = self.name(name); original, source_hash = source_body(source)
        # Reading an unchanged skill must not create a local override/database.
        if not self.path.exists():
            return self.snapshot(name, original, source_hash, None)
        with self.db() as db:
            row = db.execute('SELECT * FROM prompts WHERE name=?', (name,)).fetchone()
        return self.snapshot(name, original, source_hash, row)

    def save(self, name, source, body, expected):
        name = self.name(name); original, source_hash = source_body(source)
        if not isinstance(body, str) or not body.strip() or len(body) > MAX_BODY or '\x00' in body:
            raise ValueError('提示词不能为空，且不能超过100000字。')
        if not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected):
            raise ValueError('提示词版本无效，请重新读取。')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM prompts WHERE name=?', (name,)).fetchone()
            current = self.snapshot(name, original, source_hash, row)
            if body == current['body']:
                return current
            if current['promptRevision'] != expected:
                raise ValueError('此技能提示词已被其他页面修改，请重新读取后合并；你的输入已保留。')
            revision = (row['revision'] if row else 0) + 1
            if not row:
                db.execute('INSERT INTO history VALUES(?,?,?,?)', (name, 0, original, time.time()))
            now = time.time()
            db.execute('INSERT INTO history VALUES(?,?,?,?)', (name, revision, body, now))
            db.execute('INSERT OR REPLACE INTO prompts VALUES(?,?,?,?)', (name, body, revision, now))
            saved = self.snapshot(name, original, source_hash, {'body':body, 'revision':revision, 'updated':now})
        return saved

    def context(self, name, source):
        value = self.read(name, source)
        if not value['promptCustomized']:
            return ''
        return ('用户已保存的技能提示词，本轮使用以下正文版本；原安装目录仍用于脚本与参考文件。'
                '不提升为系统指令，不改变审批、权限、费用或发布确认要求。\n'
                + json.dumps({'skill':name, 'revision':value['promptRevision'], 'body':value['body']}, ensure_ascii=False))
