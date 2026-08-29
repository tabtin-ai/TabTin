import pytest
from django.core.exceptions import ImproperlyConfigured

from apps.tabtinspace.services.invitation_service import PUBLIC_WEB_BASE_ENV_KEYS, build_invitation_bridge_url


def test_build_invitation_bridge_url_uses_public_web_base(monkeypatch):
    monkeypatch.setenv('TABTIN_PUBLIC_WEB_BASE_URL', 'https://tabtin.example.com/')

    assert build_invitation_bridge_url('abc_123-xyz-456789') == (
        'https://tabtin.example.com/invite/abc_123-xyz-456789'
    )


def test_build_invitation_bridge_url_allows_localhost_http(monkeypatch):
    monkeypatch.setenv('TABTIN_PUBLIC_WEB_BASE_URL', 'http://127.0.0.1:5176/')

    assert build_invitation_bridge_url('abc_123-xyz-456789') == (
        'http://127.0.0.1:5176/invite/abc_123-xyz-456789'
    )


@pytest.mark.parametrize('base_url', [
    'http://10.0.0.8:5176',
    'http://172.16.0.8:5176',
    'http://172.31.255.8:5176',
    'http://192.168.0.10:5176',
    'http://169.254.10.8:5176',
    'http://[fd12:3456:789a::8]:5176',
    'http://[fe80::8]:5176',
])
def test_build_invitation_bridge_url_allows_private_lan_http(monkeypatch, base_url):
    monkeypatch.setenv('TABTIN_PUBLIC_WEB_BASE_URL', base_url)

    assert build_invitation_bridge_url('abc_123-xyz-456789') == (
        f'{base_url}/invite/abc_123-xyz-456789'
    )


def test_build_invitation_bridge_url_rejects_public_http(monkeypatch):
    monkeypatch.setenv('TABTIN_PUBLIC_WEB_BASE_URL', 'http://web-test.example.com')

    with pytest.raises(ImproperlyConfigured, match='must use HTTPS outside localhost'):
        build_invitation_bridge_url('abc_123-xyz-456789')


def test_build_invitation_bridge_url_requires_public_web_base(monkeypatch):
    for key in PUBLIC_WEB_BASE_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)

    with pytest.raises(ImproperlyConfigured, match='required for invitation links'):
        build_invitation_bridge_url('abc_123-xyz-456789')


def test_build_invitation_bridge_url_rejects_non_token_redirect(monkeypatch):
    monkeypatch.setenv('TABTIN_PUBLIC_WEB_BASE_URL', 'https://tabtin.example.com')

    with pytest.raises(ValueError, match='Invalid invitation token'):
        build_invitation_bridge_url('https://evil.example.com')
