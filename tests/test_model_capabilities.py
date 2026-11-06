import copy
import pytest
from easel.model_capabilities import configure_model_inputs


def config(**row):
    return {'models': {'providers': {'aihub': {'baseUrl': 'https://aihub.dog/v1',
            'api': 'openai-responses', 'models': [{'id': 'gpt-6.1-sol', **row}]}}}}


def test_missing_relay_metadata_is_multimodal_and_idempotent():
    value = config()
    assert configure_model_inputs(value)
    assert value['models']['providers']['aihub']['models'][0]['input'] == ['text', 'image']
    assert not configure_model_inputs(value)


@pytest.mark.parametrize('row', [{'input': ['text']}, {'input': ['text', 'image']},
                               {'id': 'unknown-model'}, {'api': 'anthropic-messages'}])
def test_explicit_capability_or_other_model_is_preserved(row):
    value = config(**row)
    original = copy.deepcopy(value)
    assert not configure_model_inputs(value)
    assert value == original


def test_other_endpoint_is_not_assumed_multimodal():
    value = config()
    value['models']['providers']['aihub']['baseUrl'] = 'https://example.com/v1'
    assert not configure_model_inputs(value)
