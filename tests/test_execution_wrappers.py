"""Generic tool envelopes expose the same bounded evidence as direct tools."""
from types import SimpleNamespace

import pytest

from easel.execution import begin, returned


@pytest.mark.parametrize('wrapper', ['tool_call', 'tool'])
@pytest.mark.parametrize('shape', ['function', 'flat_name', 'flat_tool'])
def test_generic_wrappers_expand_actual_command_with_dict_arguments(wrapper, shape):
    payload = {'cmd': 'python task.py --token synthetic-secret', 'workdir': 'workspace'}
    envelope = ({'function': {'name': 'exec', 'arguments': payload}} if shape == 'function'
                else {('name' if shape == 'flat_name' else 'tool'): 'exec', 'input': payload})
    credentials = SimpleNamespace(token='synthetic-secret', password='')
    row = begin('s', 't', 'c', wrapper, envelope, credentials=credentials)
    assert row['name'] == 'exec' and row['kind'] == 'command'
    assert row['command'].startswith('python task.py --token ')
    assert 'synthetic-secret' not in row['command']
    assert row['cwd'] == 'workspace'
    returned(row, {'isError': False, 'details': {'status': 'completed', 'exitCode': 0},
                   'content': 'token=synthetic-secret'}, credentials=credentials)
    assert row['status'] == 'completed' and 'synthetic-secret' not in row['output']


@pytest.mark.parametrize('wrapper', ['tool_call', 'tool'])
def test_unwrapped_file_path_uses_existing_sensitive_receipt_protection(wrapper):
    row = begin('s', 't', 'c', wrapper, {
        'function': {'name': 'read_file', 'arguments': {'file_path': 'config/.env'}}})
    assert row['kind'] == 'read' and row['path'] == 'config/.env'
    returned(row, {'isError': False, 'content': 'PRIVATE', 'details': {'diff': '+PRIVATE'}})
    assert row['contentHidden'] and row['output'] == row['diff'] == ''


def test_flat_file_write_expands_path_and_preserves_change_kind():
    row = begin('s', 't', 'c', 'tool', {
        'tool': 'write_file', 'input': {'path': 'outputs/result.txt', 'content': 'body'}})
    assert row['name'] == 'write_file' and row['kind'] == 'file_change'
    assert row['path'] == 'outputs/result.txt' and row['changeKind'] == 'write'


def test_flat_path_uses_gateway_credential_redaction_after_unwrapping():
    credentials = SimpleNamespace(token='synthetic-secret', password='')
    row = begin('s', 't', 'c', 'tool_call', {
        'name': 'read_file', 'input': {'path': 'outputs/synthetic-secret/file.txt'}},
        credentials=credentials)
    assert row['kind'] == 'read'
    assert row['path'] == 'outputs/[REDACTED]/file.txt'


@pytest.mark.parametrize('envelope', [
    {'function': {'name': 'exec', 'arguments': '{"command":"do not parse"}'}},
    {'function': {'name': 'exec', 'arguments': ['not', 'a', 'dict']}},
    {'function': {'name': ' ', 'arguments': {'command': 'ignored'}}},
    {'function': {'name': 17, 'arguments': {'command': 'ignored'}}},
    {'function': {'arguments': {'command': 'ignored'}}},
    {'name': 'exec'},
])
def test_invalid_wrappers_preserve_outer_name_fields_and_do_not_guess(envelope):
    envelope = {**envelope, 'command': 'outer-command', 'path': 'outer-file'}
    row = begin('s', 't', 'c', 'tool_call', envelope)
    assert row['name'] == 'tool_call' and row['kind'] == 'tool'
    assert row['command'] == 'outer-command' and row['path'] == 'outer-file'
    assert envelope['command'] == 'outer-command'
