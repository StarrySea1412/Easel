"""Classification is durable, concurrent and does not relocate generated files."""
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from easel.artifacts import ArtifactStore
from easel.output_library import OutputLibrary, LibraryConflict, router


def test_folder_hierarchy_names_and_persistence(tmp_path):
    store = OutputLibrary(tmp_path)
    folder = store.save_folder('  项目  ')
    child = store.save_folder('参考', folder['id'])
    assert child['parent'] == folder['id']
    store.save_folder('灵感', ident=child['id'])
    assert OutputLibrary(tmp_path).snapshot()['folders'] == [folder, {**child, 'name': '灵感'}]
    with pytest.raises(LibraryConflict):
        store.save_folder('项目')
    store.save_folder('Draft')
    with pytest.raises(LibraryConflict):
        store.save_folder('draft')
    for name in ['', ' ', '..', 'a/b', 'a\\b', 'a:b', 'a\x00b', '长' * 81]:
        with pytest.raises(ValueError):
            store.save_folder(name)
    with pytest.raises(FileNotFoundError):
        store.save_folder('x', 'missing')


def test_folder_depth_and_rename_collision_are_enforced(tmp_path):
    store, parent = OutputLibrary(tmp_path), ''
    for i in range(8):
        parent = store.save_folder(str(i), parent)['id']
    with pytest.raises(ValueError, match='8层'):
        store.save_folder('too-deep', parent)
    a, b = store.save_folder('a'), store.save_folder('b')
    with pytest.raises(LibraryConflict):
        store.save_folder('a', ident=b['id'])
    assert a in store.snapshot()['folders']


def test_organize_and_remove_nested_classification_never_moves_or_deletes_files(tmp_path):
    store = OutputLibrary(tmp_path)
    (tmp_path / 'draft.md').write_text('keep original path', encoding='utf-8')
    a, b = store.save_folder('a'), store.save_folder('b')
    child = store.save_folder('child', a['id'])
    store.assign('draft.md', child['id'])
    assert OutputLibrary(tmp_path).snapshot()['files'] == {'draft.md': child['id']}
    store.assign('draft.md', b['id'])
    assert store.snapshot()['files'] == {'draft.md': b['id']}
    store.assign('draft.md', '')
    assert store.snapshot()['files'] == {}
    store.assign('draft.md', child['id'])
    store.delete_folder(a['id'])
    assert store.snapshot() == {'folders': [b], 'files': {}}
    assert (tmp_path / 'draft.md').read_text(encoding='utf-8') == 'keep original path'
    with pytest.raises(FileNotFoundError):
        store.assign('draft.md', child['id'])
    assert store.snapshot()['files'] == {}


def test_only_existing_public_files_can_be_classified(tmp_path):
    store = OutputLibrary(tmp_path)
    folder = store.save_folder('safe')
    (tmp_path / '_sessions').mkdir()
    (tmp_path / '_sessions' / 'secret.json').write_text('{}')
    (tmp_path / '.hidden').write_text('hidden')
    for path in ['../escape', '_sessions/secret.json', '.hidden', str(tmp_path.parent / 'escape')]:
        with pytest.raises(ValueError):
            store.assign(path, folder['id'])
    with pytest.raises(FileNotFoundError):
        store.assign('missing.md', folder['id'])
    with pytest.raises(ValueError):
        store.assign('_artifacts', folder['id'])


def test_parallel_folder_writes_do_not_lose_siblings(tmp_path):
    with ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(lambda n: OutputLibrary(tmp_path).save_folder(f'folder-{n}'), range(20)))
    assert len(OutputLibrary(tmp_path).snapshot()['folders']) == 20


def test_delivery_provenance_and_classification_follow_rename(tmp_path):
    project = tmp_path / 'project'
    project.mkdir()
    (project / 'draft.md').write_text('real output')
    registry, library = ArtifactStore(tmp_path), OutputLibrary(tmp_path)
    registry.present('chat-a', 'turn-a', [{'path': 'project/draft.md'}], source='test')
    registry.present('chat-b', 'turn-b', [{'path': 'project/draft.md'}], source='test')
    folder = library.save_folder('分类')
    library.assign('project/draft.md', folder['id'])
    assert {r['sessionId'] for r in library.origins('project/draft.md')} == {'chat-a', 'chat-b'}
    project.rename(tmp_path / 'renamed')
    library.renamed('project', 'renamed')
    assert library.snapshot()['files'] == {'renamed/draft.md': folder['id']}
    assert {r['sessionId'] for r in library.origins('renamed/draft.md')} == {'chat-a', 'chat-b'}
    (tmp_path / 'renamed' / 'draft.md').rename(tmp_path / 'renamed' / 'new.md')
    library.renamed('renamed/draft.md', 'renamed/new.md')
    assert len(library.origins('renamed/new.md')) == 2
    assert library.origins('project-other/draft.md') == []


def test_library_routes_report_conflict_missing_and_invalid_input(tmp_path):
    app = FastAPI()
    app.include_router(router(lambda: tmp_path))
    client = TestClient(app)
    assert client.get('/api/output-library').json() == {'folders': [], 'files': {}}
    first = client.post('/api/output-library/folders', json={'name': 'one'}).json()
    assert client.post('/api/output-library/folders', json={'name': 'one'}).status_code == 409
    assert client.post('/api/output-library/folders', json={'name': '..'}).status_code == 400
    assert client.post('/api/output-library/folders', json={'name': 'child', 'parent': 'missing'}).status_code == 404
    assert client.patch('/api/output-library/folders/missing', json={'name': 'x'}).status_code == 404
    assert client.get('/api/output-library/origins', params={'path': '../escape'}).status_code == 400
    (tmp_path / 'file.txt').write_text('original')
    assert client.put('/api/output-library/file', json={'path': 'file.txt', 'folder': first['id']}).status_code == 200
    assert client.patch('/api/output-library/folders/' + first['id'], json={'name': 'renamed'}).status_code == 200
    assert client.delete('/api/output-library/folders/' + first['id']).status_code == 200
    assert client.get('/api/output-library').json() == {'folders': [], 'files': {}}
    assert (tmp_path / 'file.txt').exists()
