"""Classification folders reference files without breaking their public paths."""
from __future__ import annotations

from contextlib import contextmanager
import secrets
import sqlite3

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .artifacts import ArtifactStore, file_path


class LibraryConflict(ValueError):
    pass


class OutputLibrary:
    def __init__(self, outputs):
        self.artifacts = ArtifactStore(outputs)

    @contextmanager
    def db(self):
        with self.artifacts.db() as db:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS library_folders(
                id TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
                UNIQUE(parent,name_key));
              CREATE TABLE IF NOT EXISTS library_files(path TEXT PRIMARY KEY, folder TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS library_sources(
                path TEXT, session TEXT, turn TEXT, PRIMARY KEY(path,session,turn));
            ''')
            db.execute('BEGIN IMMEDIATE')
            yield db

    @staticmethod
    def folder(db, ident):
        row = db.execute('SELECT * FROM library_folders WHERE id=?', (ident,)).fetchone()
        if not row:
            raise FileNotFoundError('文件夹已删除，请刷新后重试')
        return row

    @staticmethod
    def name(value):
        value = value.strip()
        if (not value or len(value) > 80 or value in {'.', '..'}
                or any(c in value for c in '/\\:') or any(ord(c) < 32 for c in value)):
            raise ValueError('文件夹名称须为1–80字，不能包含路径分隔符')
        return value

    def snapshot(self):
        with self.db() as db:
            return {'folders': [dict(r) for r in db.execute('SELECT id,parent,name FROM library_folders ORDER BY rowid')],
                    'files': {r['path']: r['folder'] for r in db.execute('SELECT * FROM library_files')}}

    def save_folder(self, name, parent='', ident=None):
        name = self.name(name)
        with self.db() as db:
            if ident:
                parent = self.folder(db, ident)['parent']
            elif parent:
                ancestor, depth = parent, 1
                while ancestor:
                    ancestor = self.folder(db, ancestor)['parent']
                    depth += 1
                    if depth > 8:
                        raise ValueError('文件夹最多支持8层')
            if db.execute('SELECT 1 FROM library_folders WHERE parent=? AND name_key=? AND id<>?',
                          (parent, name.casefold(), ident or '')).fetchone():
                raise LibraryConflict('该位置已有同名文件夹')
            if ident:
                db.execute('UPDATE library_folders SET name=?,name_key=? WHERE id=?', (name, name.casefold(), ident))
            else:
                if db.execute('SELECT COUNT(*) FROM library_folders').fetchone()[0] >= 500:
                    raise ValueError('文件夹已达500个上限')
                ident = secrets.token_hex(12)
                db.execute('INSERT INTO library_folders VALUES(?,?,?,?)', (ident, parent, name, name.casefold()))
        return {'id': ident, 'parent': parent, 'name': name}

    def delete_folder(self, ident):
        with self.db() as db:
            self.folder(db, ident)
            pending = [ident]
            while pending:
                current = pending.pop()
                pending.extend(r['id'] for r in db.execute('SELECT id FROM library_folders WHERE parent=?', (current,)))
                db.execute('DELETE FROM library_files WHERE folder=?', (current,))
                db.execute('DELETE FROM library_folders WHERE id=?', (current,))

    def assign(self, value, folder):
        target, path = file_path(self.artifacts.root, value)
        if not target.is_file():
            raise FileNotFoundError('文件已移动或删除')
        with self.db() as db:
            if folder:
                self.folder(db, folder)
                db.execute('INSERT INTO library_files VALUES(?,?) ON CONFLICT(path) DO UPDATE SET folder=excluded.folder',
                           (path, folder))
            else:
                db.execute('DELETE FROM library_files WHERE path=?', (path,))

    def origins(self, value):
        _, path = file_path(self.artifacts.root, value)
        with self.db() as db:
            rows = db.execute('''SELECT a.session,a.path,d.turn,MIN(d.created) AS created
              FROM artifacts a JOIN deliveries d ON d.artifact=a.id WHERE a.path=?
              GROUP BY a.session,d.turn ORDER BY created''', (path,)).fetchall()
            result = {(r['session'], r['turn']) for r in rows}
            result.update((r['session'], r['turn']) for r in db.execute('SELECT * FROM library_sources WHERE path=?', (path,)))
        return [{'sessionId': session, 'turnId': turn, 'evidence': 'delivery'} for session, turn in sorted(result)]

    def renamed(self, old, new):
        """Keep organization/provenance when the existing rename endpoint changes a path."""
        with self.db() as db:
            def replacement(path):
                return new + path[len(old):] if path == old or path.startswith(old + '/') else None
            for row in db.execute('SELECT * FROM library_files').fetchall():
                target = replacement(row['path'])
                if target:
                    db.execute('DELETE FROM library_files WHERE path=?', (row['path'],))
                    db.execute('INSERT OR REPLACE INTO library_files VALUES(?,?)', (target, row['folder']))
            sources = db.execute('SELECT path,session,turn FROM library_sources').fetchall()
            sources += db.execute('SELECT a.path,a.session,d.turn FROM artifacts a JOIN deliveries d ON d.artifact=a.id').fetchall()
            for row in sources:
                target = replacement(row['path'])
                if target:
                    db.execute('INSERT OR IGNORE INTO library_sources VALUES(?,?,?)', (target, row['session'], row['turn']))


class FolderInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    parent: str = Field(default='', max_length=100)


class FileInput(BaseModel):
    path: str = Field(min_length=1, max_length=2000)
    folder: str = Field(default='', max_length=100)


def router(outputs):
    routes = APIRouter(prefix='/api/output-library')

    def run(method, *args, **kwargs):
        try:
            return getattr(OutputLibrary(outputs()), method)(*args, **kwargs)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except LibraryConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except (OSError, sqlite3.Error) as exc:
            raise HTTPException(503, '内容库分类暂不可用，请稍后重试') from exc

    @routes.get('')
    def snapshot():
        return run('snapshot')

    @routes.get('/origins')
    def origins(path: str):
        return {'origins': run('origins', path)}

    @routes.post('/folders')
    def create(req: FolderInput):
        return run('save_folder', req.name, req.parent)

    @routes.patch('/folders/{ident}')
    def rename(ident: str, req: FolderInput):
        return run('save_folder', req.name, ident=ident)

    @routes.delete('/folders/{ident}')
    def delete(ident: str):
        run('delete_folder', ident)
        return {'ok': True}

    @routes.put('/file')
    def assign(req: FileInput):
        run('assign', req.path, req.folder)
        return {'ok': True}

    return routes
