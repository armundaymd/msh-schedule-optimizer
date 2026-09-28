"""Refresh data is off unless ADMIN_TOKEN is set, and then needs that token.
(The check is a plain function so it can be tested without a database.)"""

import pytest
from fastapi import HTTPException

import importlib
import sys
import types


@pytest.fixture(scope="module")
def auth():
    # Import server.py's auth helpers without connecting to a database.
    real = importlib.import_module("db")
    fake_db = types.ModuleType("db")
    fake_db.__dict__.update({k: v for k, v in vars(real).items() if not k.startswith("__")})
    fake_db.get_engine = lambda: None
    fake_db.init_schema = lambda engine: None
    sys.modules["db"] = fake_db
    sys.modules.pop("server", None)
    try:
        yield importlib.import_module("server")
    finally:
        sys.modules.pop("server", None)
        if real is not None:
            sys.modules["db"] = real
        else:
            sys.modules.pop("db", None)


def test_refresh_is_disabled_without_a_configured_token(auth, monkeypatch):
    monkeypatch.delenv("ADMIN_TOKEN", raising=False)
    assert auth.api_refresh_status() == {"enabled": False}
    with pytest.raises(HTTPException) as e:
        auth.authorize_refresh("anything", auth.configured_admin_token())
    assert e.value.status_code == 403


def test_refresh_needs_the_right_token(auth, monkeypatch):
    monkeypatch.setenv("ADMIN_TOKEN", "s3cret")
    assert auth.api_refresh_status() == {"enabled": True}
    for bad in (None, "", "wrong"):
        with pytest.raises(HTTPException) as e:
            auth.authorize_refresh(bad, auth.configured_admin_token())
        assert e.value.status_code == 401
    auth.authorize_refresh("s3cret", auth.configured_admin_token())   # no exception


def test_refresh_endpoint_checks_before_running_the_pipeline(auth, monkeypatch):
    monkeypatch.delenv("ADMIN_TOKEN", raising=False)
    ran = []
    monkeypatch.setattr(auth, "run_pipeline", lambda **kw: ran.append(kw))
    with pytest.raises(HTTPException) as e:
        auth.api_refresh(force=False, x_admin_token="x")
    assert e.value.status_code == 403 and ran == []
