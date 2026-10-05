.PHONY: install test seed dev contracts
install:
	pnpm install && uv sync --python 3.12
contracts:
	pnpm contracts:gen
test:
	uv run pytest -q && pnpm -r --if-present test
seed:
	uv run python -m butler_local.seed
dev:
	uv run python -m butler_local.dev
