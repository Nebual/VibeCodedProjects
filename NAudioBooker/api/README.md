# naudiobooker (API)

Python backend: EPUB parsing, text normalisation, TTS synthesis, audio assembly
and tagging. See `../PLAN.md` for the architecture.

## Run

```bash
uv sync --extra dev
uv run uvicorn naudiobooker.main:app --reload --port 8000
```

## Roles

The same package runs in three modes, selected by `NAB_ROLE`:

| Role | Purpose |
|---|---|
| `api` | Serves HTTP, owns the SQLite database, dispatches jobs. |
| `worker` | Drains the job queue on the primary host. Shares the filesystem with `api`. |
| `worker-node` | Stateless remote synthesiser (the GPU box). Exposes only `/synthesize` and `/health`; holds no book state. |

## Configuration

All settings take a `NAB_` prefix and may also be set in `api/.env`.
See `naudiobooker/config.py` for the full list.

## Tests

```bash
uv run pytest
```
