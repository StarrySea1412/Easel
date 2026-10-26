"""Compatibility import for web callers; contracts belong to the shared runtime."""
from easel.agent_roles import ROLE_SCHEMA_VERSION, get_role, list_roles, role_context, role_snapshot

__all__ = ['ROLE_SCHEMA_VERSION', 'get_role', 'list_roles', 'role_context', 'role_snapshot']
