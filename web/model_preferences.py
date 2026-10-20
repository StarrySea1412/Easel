"""Easel's provider enablement, separate from OpenClaw's provider schema."""
import json
from pathlib import Path


def path_for(config_path: Path) -> Path:
    return config_path.with_name('easel-disabled-providers.json')


def order_path(config_path: Path) -> Path:
    return config_path.with_name('easel-provider-order.json')


def provider_order(config_path: Path) -> list[str]:
    path = order_path(config_path)
    if not path.exists():
        return []
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise ValueError('invalid provider order')
        return list(dict.fromkeys(value))
    except (OSError, ValueError):
        raise ValueError('无法读取渠道排序，请检查配置文件后重试') from None


def disabled_providers(config_path: Path) -> set[str]:
    path = path_for(config_path)
    if not path.exists():
        return set()
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise ValueError('invalid provider preferences')
        return set(value)
    except (OSError, ValueError):
        # Do not silently enable previously disabled channels.
        raise ValueError('无法读取渠道启停设置，请检查配置文件后重试') from None
