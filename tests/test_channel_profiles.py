import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import channel_profiles as profiles
import local_config_import
import office_controls
import model_health

@pytest.fixture
def channels(tmp_path, monkeypatch):
    target=model_health.Target('relay/model', 'relay', 'model', 'openai', 'https://fixture.invalid/v1', 'fixture-secret')
    monkeypatch.setattr(web, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(web, 'openclaw_state_dir', lambda: tmp_path)
    monkeypatch.setattr(web, '_model_health_target', lambda ref: target if ref=='relay/model' else None)
    monkeypatch.setattr(office_controls, 'configured_models', lambda _: [{'id':'relay/model','provider':'relay'}])
    monkeypatch.setattr(local_config_import, 'resolve_source', lambda *_: (tmp_path/'cc-switch.db', None))
    candidates=[{'name':'CC 渠道甲','baseUrl':target.base,'key':target.key,'protocol':target.protocol}]
    monkeypatch.setattr(local_config_import, 'read_source', lambda *_: (candidates, None))
    return SimpleNamespace(target=target, candidates=candidates, root=tmp_path)

def test_exact_source_name_and_edit_do_not_change_config_or_expose_credentials(channels):
    assert profiles.labels(web)['relay']['name']=='CC 渠道甲'
    profiles.save(web,'relay','编辑名称')
    value=profiles.labels(web)['relay']
    assert value['name']=='编辑名称' and value['sourceName']=='CC 渠道甲'
    assert 'fixture-secret' not in (channels.root/'channel-names.json').read_text(encoding='utf-8')
    assert channels.target.key=='fixture-secret'

def test_ambiguous_or_different_credentials_never_guess_channel_name(channels):
    channels.candidates.append({**channels.candidates[0], 'name':'另一个渠道'})
    assert profiles.labels(web)['relay']['name']=='未命名渠道'
    channels.candidates[:]=[{**channels.candidates[0], 'key':'different'}]
    assert profiles.labels(web)['relay']['name']=='未命名渠道'

def test_corrupt_original_not_overwritten_and_names_validated(channels):
    p=channels.root/'channel-names.json';p.write_text('{broken')
    with pytest.raises(ValueError): profiles.save(web,'relay','new')
    assert p.read_text()=='{broken'
    for invalid in ('', 'x'*81, 'a\nb'):
        with pytest.raises(ValueError): profiles.save(web,'relay',invalid)

def test_changed_channel_invalidates_saved_name(channels, monkeypatch):
    profiles.save(web,'relay','旧显示名')
    changed=model_health.Target('relay/model','relay','model','openai',channels.target.base,'changed-key')
    monkeypatch.setattr(web,'_model_health_target',lambda _:changed)
    assert profiles.labels(web)['relay']['name']=='未命名渠道'

@pytest.mark.parametrize('kind,state', [('ok','success'),('not_found','unverified'),('unsupported','unverified'),('unauthorized','failed')])
def test_connection_is_only_model_list_evidence_and_uses_channel_cache(channels,monkeypatch,kind,state):
    web._CHANNEL_CONNECTIONS.clear();calls=[]
    monkeypatch.setattr(web,'_model_health_service',lambda:SimpleNamespace(target=lambda _:channels.target))
    def discover(*args):
        calls.append(args);return {'ok':kind=='ok','kind':kind,'models':['model'],'message':'fixture list result'}
    monkeypatch.setattr(web,'_discover_models',discover)
    result=asyncio.run(web.api_channel_connection('relay/model'))
    again=asyncio.run(web.api_channel_connection('relay/model'))
    assert result['state']==state and result['channelName']=='CC 渠道甲'
    assert result['modelListed'] and len(calls)==1 and again['kind']==kind
    assert 'fixture-secret' not in json.dumps(result)

def test_connection_rejects_late_response_after_reconfiguration(channels,monkeypatch):
    web._CHANNEL_CONNECTIONS.clear();current=[channels.target]
    monkeypatch.setattr(web,'_model_health_service',lambda:SimpleNamespace(target=lambda _:current[0]))
    def discover(*_):
        current[0]=model_health.Target('relay/model','relay','model','openai','https://changed.invalid','new')
        return {'ok':True,'models':['model']}
    monkeypatch.setattr(web,'_discover_models',discover)
    with pytest.raises(HTTPException) as exc: asyncio.run(web.api_channel_connection('relay/model'))
    assert exc.value.status_code==409

def test_stop_request_for_old_turn_never_stops_new_run(monkeypatch):
    calls=[];proc=SimpleNamespace(poll=lambda:None,terminate=lambda:calls.append('stop'))
    monkeypatch.setitem(web._RUNNING_CHAT,'turn-fence',proc)
    monkeypatch.setitem(web._ACTIVE_SKILL_TURNS,'turn-fence','new-turn')
    assert asyncio.run(web.api_chat_stop(web.StopRequest(sessionId='turn-fence',turnId='old-turn')))=={'stopped':False}
    assert calls==[]
