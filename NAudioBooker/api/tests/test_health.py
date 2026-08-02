from fastapi.testclient import TestClient

from naudiobooker.main import create_app


def test_health_reports_version_and_role() -> None:
    with TestClient(create_app()) as client:
        res = client.get("/health")

    assert res.status_code == 200
    body = res.json()
    assert body["version"] == "0.1.0"
    assert body["role"] == "api"
    # tts_backend is where synthesis runs; the model is reported separately,
    # since "Chatterbox Nano, locally" needs both to be expressible.
    assert body["tts_backend"] == "local"
    assert body["tts"]["model"] == "kokoro"
    assert set(body["deps"]) == {"ffmpeg", "espeak_ng"}


def test_health_is_degraded_when_a_dep_is_missing(monkeypatch) -> None:
    monkeypatch.setattr(
        "naudiobooker.main.shutil.which",
        lambda name: None if name == "ffmpeg" else "/usr/bin/espeak-ng",
    )
    with TestClient(create_app()) as client:
        body = client.get("/health").json()

    assert body["status"] == "degraded"
    assert body["deps"]["ffmpeg"] is False
