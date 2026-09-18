.PHONY: install lint test migrate run worker compose-up compose-down
install:
	uv sync --all-groups
lint:
	uv run ruff check .
test:
	uv run pytest -q
migrate:
	uv run alembic upgrade head
run:
	uv run uvicorn app.main:app --reload --port 8000
worker:
	uv run celery -A app.workers:celery_app worker -l INFO -Q critical,default,cpu_heavy,agents
compose-up:
	docker compose up --build
compose-down:
	docker compose down
