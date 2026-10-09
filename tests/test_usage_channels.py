import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import usage_channels as channels
import usage_stats as usage


def config(path, endpoint):
    path.write_text(json.dumps({'models': {'providers': {'relay': {'baseUrl': endpoint, 'api': 'openai-completions', 'apiKey': 'SECRET-NOT-IN-LEDGER'}}}}))
    return channels.capture_channels(path)


def call(provider='relay'):
    return {'provider': provider, 'model': 'same-model', 'timestamp': '2026-10-09T12:00:01+00:00',
            'endTimestamp': '2026-10-09T12:00:03+00:00'}


def snapshot(routes):
    return {'started': 1791547200, 'finished': 1791547210, '_usageChannels': routes}


def test_snapshot_removes_secrets_and_separates_endpoint_routes(tmp_path):
    p = tmp_path / 'config.json'
    a = config(p, 'https://user:password@a.example/v1?api_key=PRIVATE#token')
    b = config(p, 'https://b.example/v1')
    assert a['relay']['channelEndpoint'] == 'a.example'
    assert a['relay']['channelId'] != b['relay']['channelId']
    assert not any(secret in json.dumps(a) for secret in ('SECRET', 'PRIVATE', 'password', 'user:'))


def test_actual_provider_and_unique_turn_boundary_required(tmp_path):
    routes = config(tmp_path / 'config.json', 'https://a.example/v1')
    observed = call(); channels.attach_channel(observed, [snapshot(routes)])
    assert observed['channelEndpoint'] == 'a.example'
    fallback = call('fallback'); channels.attach_channel(fallback, [snapshot(routes)])
    assert fallback['channelEndpoint'] is None
    ambiguous = call(); channels.attach_channel(ambiguous, [snapshot(routes), snapshot(routes)])
    assert ambiguous['channelSource'] == 'transcript_provider'
    outside = call(); outside['timestamp'] = '2026-10-09T11:00:00+00:00'
    channels.attach_channel(outside, [snapshot(routes)])
    assert outside['channelEndpoint'] is None


def test_persisted_route_survives_config_change(tmp_path):
    p = tmp_path / 'config.json'; old = call()
    channels.attach_channel(old, [snapshot(config(p, 'https://a.example/v1'))])
    observed = call(); channels.attach_channel(observed, [snapshot(config(p, 'https://b.example/v1'))], old)
    assert observed['channelEndpoint'] == 'a.example'
    assert observed['channelId'] == old['channelId']
    legacy = call(); channels.attach_channel(legacy, [])
    assert legacy['channelId'] == 'relay' and legacy['channelEndpoint'] is None


def test_new_turn_captures_display_name_while_historical_name_is_immutable(tmp_path):
    p=tmp_path/'config.json';config(p,'https://a.example/v1')
    before=channels.capture_channels(p, {'relay':{'name':'CC Switch 原名称'}})
    old=call();channels.attach_channel(old,[snapshot(before)])
    after=channels.capture_channels(p, {'relay':{'name':'用户新名称'}})
    observed=call();channels.attach_channel(observed,[snapshot(after)],old)
    assert after['relay']['channelName']=='用户新名称'
    assert observed['channelName']=='CC Switch 原名称'


def test_same_model_on_different_channels_is_grouped_and_priced_separately(tmp_path):
    p = tmp_path / 'config.json'; rows = []
    for endpoint in ('https://a.example/v1', 'https://b.example/v1'):
        row = call(); channels.attach_channel(row, [snapshot(config(p, endpoint))])
        row.update(inputTokens=1000, outputTokens=1000, cacheReadTokens=0, cacheWriteTokens=0, totalTokens=2000)
        rows.append(row)
    price = {'currency': 'USD', 'input': '1', 'output': '1', 'cacheRead': '0', 'cacheWrite': '0', 'multiplier': '1', 'source': 'fixture'}
    prices = {f"{rows[0]['channelId']}/same-model": price, 'relay/same-model': {**price, 'input': '100'}}
    for row in rows:
        usage._enrich(row, prices)
    assert rows[0]['estimatedCostUsd'] == .002 and rows[1].get('estimatedCostUsd') is None
    groups = channels.channel_groups(rows, usage.summarize)
    assert len(groups) == 2 and sum(group['summary']['calls'] for group in groups) == 2
    assert {group['endpoint'] for group in groups} == {'a.example', 'b.example'}


def test_snapshot_is_read_only_from_own_session(tmp_path):
    sessions = tmp_path / '_sessions'; sessions.mkdir()
    folder = tmp_path / '_skill_audits' / hashlib.sha256(b'own').hexdigest()[:24]; folder.mkdir(parents=True)
    (folder / 'own.json').write_text(json.dumps({'sessionId': 'own', '_usageChannels': {}}))
    (folder / 'foreign.json').write_text(json.dumps({'sessionId': 'foreign', '_usageChannels': {}}))
    assert len(channels.read_snapshots(sessions, 'own')) == 1
