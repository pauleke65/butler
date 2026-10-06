import socket
import sys

from butler_local.dev import SERVICES, Supervisor, build_env, module_available, wait_port


def test_build_env_defaults_and_dummy_keys():
    env = build_env({})
    assert env["TABLE_NAME"] == "butler-local" and env["DYNAMODB_ENDPOINT"] == "http://localhost:5555"
    assert env["GATEWAY_URL"] == "http://localhost:8090/mcp" and env["LLM_MODE"] == "offline"
    assert env["AWS_ACCESS_KEY_ID"] == "test" and env["AWS_SECRET_ACCESS_KEY"] == "test"


def test_build_env_never_injects_dummy_keys_for_bedrock_and_respects_overrides():
    env = build_env({"LLM_MODE": "bedrock", "TABLE_NAME": "mine"})
    assert "AWS_ACCESS_KEY_ID" not in env and env["TABLE_NAME"] == "mine"
    assert build_env({"AWS_ACCESS_KEY_ID": "real"})["AWS_ACCESS_KEY_ID"] == "real"


def test_ports_and_optional_modules():
    assert {s.name: s.port for s in SERVICES} == {"devdb": 5555, "gateway": 8090, "executor": 8081, "debug-api": 8085, "agent": 8080}
    assert module_available("butler_local.gateway") and not module_available("no_such_pkg.server")


def test_wait_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        assert wait_port(s.getsockname()[1], timeout=2)
    assert not wait_port(1, timeout=0.3)


def test_supervisor_run_once_and_logging(capsys):
    sup = Supervisor(build_env({}))
    assert sup.run_once("seed", "json.tool", "--help") == 0
    assert "[seed" in capsys.readouterr().out
    assert sys.executable
