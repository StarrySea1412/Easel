"""Fill missing input metadata for explicitly supported relay model routes."""
from urllib.parse import urlsplit


def configure_model_inputs(config):
    """Do not interpret omitted input as an operator's text-only restriction."""
    providers = config.get('models', {}).get('providers', {})
    provider = providers.get('aihub') if isinstance(providers, dict) else None
    if not isinstance(provider, dict):
        return False
    try:
        endpoint = urlsplit(provider.get('baseUrl', ''))
    except (TypeError, ValueError):
        return False
    if (endpoint.scheme != 'https' or endpoint.hostname not in {'aihub.dog', 'aihub.top'}
            or endpoint.path.rstrip('/') not in {'', '/v1'}):
        return False
    changed = False
    for model in provider.get('models', []):
        if (isinstance(model, dict) and model.get('id') == 'gpt-6.1-sol'
                and model.get('api', provider.get('api')) == 'openai-responses'
                and 'input' not in model):
            model['input'] = ['text', 'image']
            changed = True
    return changed
