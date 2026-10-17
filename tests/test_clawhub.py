"""Public catalog protocol and failure handling; all upstream requests are simulated."""
import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import clawhub


def item(owner='alice', slug='research', **changes):
    return dict(slug=slug, ownerHandle=owner, displayName='Research', summary='<script>untrusted</script>',
                canonicalUrl=f'/{owner}/skills/{slug}', **changes)


def test_search_is_anonymous_cached_and_deduplicated_by_author():
    calls = []
    def upstream(request):
        calls.append(request)
        assert request.url.host == 'clawhub.ai'
        assert not any(key in request.headers for key in ['authorization', 'cookie'])
        return httpx.Response(200, json={'results': [item(), item(), item('bob'), item(owner='../bad'),
                                                     {**item(), 'source': 'other'}]})
    client = clawhub.ClawHubClient(transport=httpx.MockTransport(upstream))
    async def run():
        first, second = await asyncio.gather(client.search('research'), client.search('research'))
        cached = await client.search('research')
        assert first == second
        assert cached['cacheHit'] and not first['cacheHit']
        assert [row['id'] for row in first['results']] == ['clawhub:alice/research', 'clawhub:bob/research']
        assert first['omittedCount'] == 2
        assert first['results'][0]['summary'] == '<script>untrusted</script>'
        assert all(row['installationState'] == 'not_checked' for row in first['results'])
    asyncio.run(run())
    assert len(calls) == 1


@pytest.mark.parametrize('query,limit', [('', 12), ('x' * 201, 12), ('a\n', 12), ('x', 0), ('x', 21)])
def test_bad_search_never_contacts_upstream(query, limit):
    def unexpected(_):
        pytest.fail('Invalid input must not contact ClawHub')
    client = clawhub.ClawHubClient(transport=httpx.MockTransport(unexpected))
    with pytest.raises(HTTPException) as error:
        asyncio.run(client.search(query, limit))
    assert error.value.status_code == 400


@pytest.mark.parametrize('status,expected', [(301, 502), (401, 502), (404, 404), (409, 409), (500, 502)])
def test_remote_errors_use_local_messages(status, expected):
    client = clawhub.ClawHubClient(transport=httpx.MockTransport(lambda _: httpx.Response(status, text='private upstream error')))
    with pytest.raises(HTTPException) as error:
        asyncio.run(client.detail('research', 'alice'))
    assert error.value.status_code == expected
    assert 'private upstream error' not in error.value.detail


def test_rate_limit_blocks_following_requests_and_preserves_retry_after():
    calls = []
    def upstream(request):
        calls.append(request)
        return httpx.Response(429, headers={'Retry-After': '30'})
    client = clawhub.ClawHubClient(transport=httpx.MockTransport(upstream))
    async def run():
        for query in ['one', 'two']:
            with pytest.raises(HTTPException) as error:
                await client.search(query)
            assert error.value.status_code == 429
            assert 1 <= int(error.value.headers['Retry-After']) <= 30
    asyncio.run(run())
    assert len(calls) == 1


@pytest.mark.parametrize('payload', [[], {'results': 'bad'}, {'results': None}])
def test_malformed_payloads_are_not_reported_as_empty_success(payload):
    client = clawhub.ClawHubClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)))
    with pytest.raises(HTTPException) as error:
        asyncio.run(client.search('research'))
    assert error.value.status_code == 502


def test_response_size_and_timeout_are_bounded(monkeypatch):
    monkeypatch.setattr(clawhub, 'MAX_RESPONSE_BYTES', 10)
    client = clawhub.ClawHubClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={'results': []})))
    with pytest.raises(HTTPException) as error:
        asyncio.run(client.search('research'))
    assert error.value.status_code == 502
    def timeout(_):
        raise httpx.ReadTimeout('upstream timeout')
    client = clawhub.ClawHubClient(transport=httpx.MockTransport(timeout))
    with pytest.raises(HTTPException) as error:
        asyncio.run(client.search('research'))
    assert error.value.status_code == 504


def test_detail_checks_author_and_slug_and_never_uses_external_canonical_url():
    payload = {'skill': {**item(), 'canonicalUrl': 'https://evil.example/steal', 'description': 'author text'},
               'owner': {'handle': 'alice'}, 'latestVersion': {'version': '1.2.3'},
               'moderation': {'isSuspicious': True}}
    client = clawhub.ClawHubClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)))
    async def run():
        result = await client.detail('research', 'alice')
        assert result['skill']['canonicalUrl'] == 'https://clawhub.ai/alice/skills/research'
        assert result['latestVersion']['version'] == '1.2.3'
        assert result['moderation']['isSuspicious']
        for slug, owner in [('research', 'bob'), ('other', 'alice')]:
            with pytest.raises(HTTPException) as error:
                await client.detail(slug, owner)
            assert error.value.status_code == 502
    asyncio.run(run())


def test_main_app_mounts_read_only_catalog_routes():
    routes = {path: set(operations) for path, operations in web.app.openapi()['paths'].items() if path.startswith('/api/clawhub')}
    assert routes == {'/api/clawhub/search': {'get'}, '/api/clawhub/skills/{slug}': {'get'}}


def test_public_counters_flow_through_search_and_detail_without_inventing_issues():
    row = {**item(), 'downloads': 5609,
           'native': {'skill': {'stats': {'comments': 3, 'downloads': 5609, 'installs': 148, 'stars': 7, 'versions': 7}}}}
    client = clawhub.ClawHubClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={'results': [row]})))
    async def run_search():
        found = await client.search('research')
        stats = found['results'][0]['stats']
        assert stats == {'downloads': 5609, 'stars': 7, 'installs': 148, 'versions': 7, 'comments': 3}
        assert 'issues' not in stats
    asyncio.run(run_search())

    payload = {'skill': {**item(), 'stats': {'downloads': 10, 'stars': 1, 'installs': 2, 'versions': 3, 'comments': 0}},
               'owner': {'handle': 'alice'}}
    client = clawhub.ClawHubClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)))
    async def run_detail():
        result = await client.detail('research', 'alice')
        assert result['skill']['stats'] == {'downloads': 10, 'stars': 1, 'installs': 2, 'versions': 3, 'comments': 0}
    asyncio.run(run_detail())
