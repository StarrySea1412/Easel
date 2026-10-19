import asyncio
import hashlib
import io
import json
from pathlib import Path
import stat
import zipfile

import httpx
import pytest
from fastapi import HTTPException

from web.clawhub import ClawHubClient
from web.clawhub_import import SkillImporter, unpack
from easel.imported_skills import installed, local_name, skill_path


def archive(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as f:
        for name, content in entries:
            if isinstance(name, str):
                raw = zipfile.ZipInfo(name)
                raw.filename = name  # Keep hostile backslashes on Windows too.
                name = raw
            f.writestr(name, content)
    return output.getvalue()


@pytest.mark.parametrize('name', ['../SKILL.md', '/SKILL.md', 'x\\SKILL.md', '.env', 'x/../run.py', 'x:run.py'])
def test_archive_rejects_unsafe_paths(name):
    with pytest.raises(ValueError, match='不安全'):
        unpack(archive([('SKILL.md', '# Safe'), (name, 'unsafe')]))


def test_archive_rejects_symlink_and_case_collisions():
    link = zipfile.ZipInfo('helper')
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    with pytest.raises(ValueError, match='不安全'):
        unpack(archive([('SKILL.md', '# Safe'), (link, '/etc/passwd')]))
    with pytest.raises(ValueError, match='不安全'):
        unpack(archive([('SKILL.md', '# Safe'), ('skill.md', '# Other')]))


def test_pinned_import_registers_owner_identity_and_never_executes_scripts(tmp_path):
    content = '---\nname: research\ndescription: Author instructions\n---\n# Research'
    zip_bytes = archive([('SKILL.md', content), ('scripts/demo.py', 'raise RuntimeError("must never execute")')])
    requests = []
    def upstream(request):
        requests.append(request)
        assert request.url.host == 'clawhub.ai'
        assert not request.headers.get('authorization') and not request.headers.get('cookie')
        if request.url.path.endswith('/download'):
            assert request.url.params['version'] == '1.2.3'
            assert request.url.params['ownerHandle'] == 'alice', 'download must disambiguate same-name publishers'
            return httpx.Response(200, content=zip_bytes, headers={'Content-Type': 'application/zip'})
        return httpx.Response(200, json={'skill': {'slug': 'research', 'displayName': 'Research'},
            'owner': {'handle': 'alice'}, 'latestVersion': {'version': '1.2.3'}})
    service = SkillImporter(tmp_path / 'data', tmp_path / 'bundled', ClawHubClient(transport=httpx.MockTransport(upstream)))
    result = asyncio.run(service.import_skill('research', 'alice', '1.2.3'))
    name = result['name']
    assert name == local_name('alice', 'research') != local_name('bob', 'research')
    assert not result['alreadyInstalled']
    assert installed(service.data)[name]['owner'] == 'alice'
    path = skill_path(service.bundled, service.data, name)
    assert path.read_text() == content
    assert (path.parent / 'scripts/demo.py').is_file()
    again = asyncio.run(service.import_skill('research', 'alice', '1.2.3'))
    assert again['alreadyInstalled']
    assert len([r for r in requests if r.url.path.endswith('/download')]) == 1
    path.write_text('tampered')
    assert not installed(service.data)


@pytest.mark.parametrize('moderation,version', [({'isMalwareBlocked': True}, '1.2.3'), ({'isSuspicious': True}, '1.2.3'), ({}, '9.9.9')])
def test_blocked_or_changed_version_never_downloads(tmp_path, moderation, version):
    def upstream(request):
        assert not request.url.path.endswith('/download')
        return httpx.Response(200, json={'skill': {'slug': 'research'}, 'owner': {'handle': 'alice'},
            'latestVersion': {'version': '1.2.3'}, 'moderation': moderation})
    service = SkillImporter(tmp_path, tmp_path / 'bundled', ClawHubClient(transport=httpx.MockTransport(upstream)))
    with pytest.raises(HTTPException) as error:
        asyncio.run(service.import_skill('research', 'alice', version))
    assert error.value.status_code == 409
    assert not installed(tmp_path)


def test_import_is_available_to_catalog_detail_and_chat_without_shadowing(tmp_path, monkeypatch):
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
    import app as web
    service = SkillImporter(tmp_path / 'data', tmp_path / 'bundled')
    text = '\ufeff---\nname: research\ndescription: Imported research\n---\n# Research\nRead references/guide.md.'
    result = service.store(local_name('alice', 'research'), {'ownerHandle': 'alice', 'slug': 'research',
        'version': '1.2.3', 'displayName': 'Research'}, {'SKILL.md': text.encode(), 'references/guide.md': b'# Reference'}, b'archive')
    monkeypatch.setattr(web, 'DATA_DIR', service.data)
    monkeypatch.setattr(web, 'SKILLS_DIR', tmp_path / 'skills')
    monkeypatch.setattr(web, 'ENV_FILE', tmp_path / 'empty.env')
    name = result['name']
    row = next(row for row in web.get_skills() if row['name'] == name)
    assert row['provenance'] == {'owner': 'alice', 'slug': 'research', 'version': '1.2.3'}
    detail = asyncio.run(web.api_skill_detail(name))
    assert detail['source'] == 'clawhub' and detail['description'] == 'Imported research'
    request = web.ChatRequest(message='Use my selected skill', selectedSkills=[name])
    assert name in web._selected_skill_specs(request)
    assert str(web._skill_md_path(name)) in web._chat_message(request)
    assert web.find_skill('research') is None
