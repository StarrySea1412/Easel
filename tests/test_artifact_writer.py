import hashlib
from pathlib import Path

import pytest

from easel.artifact_writer import write_artifact


def test_chunks_resume_validate_and_commit_without_overwriting(tmp_path):
    def run(operation, **kw):
        return write_artifact(tmp_path, 'session-a', dict(operation=operation, requestId='report', **kw))
    assert run('begin', filename='report.html')['nextSequence'] == 0
    run('append', sequence=0, text='<html>中文')
    assert run('append', sequence=0, text='<html>中文')['nextSequence'] == 1
    with pytest.raises(ValueError, match='不同内容'):
        run('append', sequence=0, text='other')
    with pytest.raises(ValueError):
        run('append', sequence=2, text='gap')
    with pytest.raises(ValueError):
        run('commit', expectedChunks=2)
    assert run('status')['nextSequence'] == 1
    run('append', sequence=1, text='</html>')
    result = run('commit', expectedChunks=2)
    data = Path(result['path']).read_bytes()
    assert data == '<html>中文</html>'.encode()
    assert result['sha256'] == hashlib.sha256(data).hexdigest()
    assert run('commit', expectedChunks=2) == result
    with pytest.raises(ValueError):
        run('append', sequence=2, text='late')
    assert run('status')['committed'] is True
    # A new request cannot clobber a committed artifact.
    def other(operation, **kw):
        return write_artifact(tmp_path, 'session-a', dict(operation=operation, requestId='other', **kw))
    other('begin', filename='report.html')
    other('append', sequence=0, text='different')
    with pytest.raises(ValueError, match='同名成品'):
        other('commit', expectedChunks=1)
    assert Path(result['path']).read_bytes() == data


def test_restart_ignores_uncommitted_temporary_and_checks_saved_hash(tmp_path):
    args = dict(requestId='x')
    write_artifact(tmp_path, 'one', dict(args, operation='begin', filename='one.md'))
    write_artifact(tmp_path, 'one', dict(args, operation='append', sequence=0, text='saved'))
    folder = next((tmp_path / '_artifact_writes').glob('*/*'))
    (folder / '.pending-crash').write_text('partial not confirmed')
    assert write_artifact(tmp_path, 'one', dict(args, operation='status'))['nextSequence'] == 1
    with pytest.raises(ValueError, match='先begin'):
        write_artifact(tmp_path, 'two', dict(args, operation='status'))
    (folder / 'chunk-0000.json').write_text('{"text":"tampered","sha256":"wrong"}')
    with pytest.raises(ValueError, match='摘要'):
        write_artifact(tmp_path, 'one', dict(args, operation='status'))


@pytest.mark.parametrize('name', ['../bad.html', '/tmp/bad.md', 'bad.exe', 'x\\bad.md'])
def test_names_cannot_escape_artifact_root(tmp_path, name):
    with pytest.raises(ValueError):
        write_artifact(tmp_path, 'one', dict(operation='begin', requestId='x', filename=name))


def test_chunk_bound_and_filename_identity(tmp_path):
    args = dict(requestId='x')
    write_artifact(tmp_path, 'one', dict(args, operation='begin', filename='one.md'))
    with pytest.raises(ValueError):
        write_artifact(tmp_path, 'one', dict(args, operation='begin', filename='two.md'))
    with pytest.raises(ValueError):
        write_artifact(tmp_path, 'one', dict(args, operation='append', sequence=0, text='a' * 3001))
