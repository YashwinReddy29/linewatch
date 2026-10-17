# Run from the repo root. Local (non-Docker) targets expect the venv to be active.
.PHONY: up down logs ps worker web test test-worker test-web lint audit compare report precision eval \
        bench-up bench-load bench-dupes bench-outage bench-down outbox

-include .env
WEB_PORT ?= 3000
DB_PORT ?= 5433
BENCH_WEB_PORT ?= 3200
BENCH_DB_PORT ?= 5440
TEST_DATABASE_URL ?= postgres://linewatch:$(POSTGRES_PASSWORD)@localhost:$(DB_PORT)/linewatch_test

up:            ## everything in Docker: inference, worker, web, db
	docker compose up --build -d
	@echo "Console: http://localhost:$(WEB_PORT)"

down:
	docker compose down

logs:          ## worker + web logs only (the Inference server logs every request)
	docker compose logs -f worker web

ps:            ## service health
	docker compose ps

worker:        ## worker on this machine (Inference server must be running)
	PYTHONPATH=worker python -m linewatch.main

web:           ## web console in dev mode (needs Postgres; see README)
	cd web && npm run dev

test: test-worker test-web

test-worker:
	cd worker && python -m pytest -q

test-web:      ## web unit + integration tests against the compose Postgres (database linewatch_test)
	@docker compose exec -T db psql -U linewatch -d linewatch -tAc "SELECT 1 FROM pg_database WHERE datname='linewatch_test'" | grep -q 1 \
	  || docker compose exec -T db createdb -U linewatch linewatch_test
	cd web && TEST_DATABASE_URL="$(TEST_DATABASE_URL)" npm test

lint:
	cd worker && ruff check . && ruff format --check .
	cd web && npm run lint && npm run typecheck

audit:         ## known-vulnerability check of runtime dependencies
	cd web && npm audit --omit=dev --audit-level=high
	pip-audit -r worker/requirements.txt

outbox:        ## incidents waiting in the worker outbox, and dead letters
	OUT_DIR=out PYTHONPATH=worker python -m linewatch.outbox status

compare:       ## compare candidate models on your clips
	python eval/compare_models.py samples/street-crew.mp4 samples/two-people.mp4 samples/vests-walking.mp4 samples/site1.mp4 --frames 4 --conf 0.3

report:        ## latency and detection-rate summary of the latest worker run
	python eval/latency_report.py

precision:     ## incident precision from your reviews in the console
	python eval/review_precision.py

eval:          ## precision / recall / mAP@50 on your labeled test set
	python eval/eval_detections.py eval/testset/test

# ---- benchmarks: a separate stack (own database volume), never your real console ----

bench-up:
	WEB_PORT=$(BENCH_WEB_PORT) DB_PORT=$(BENCH_DB_PORT) docker compose -p linewatch-bench up -d --build --wait db web

bench-load:    ## 500 incidents, 8 concurrent senders
	python bench/ingest_load.py --web http://localhost:$(BENCH_WEB_PORT) --incidents 500 --concurrency 8

bench-dupes:   ## every incident delivered 3 times at once
	python bench/ingest_load.py --web http://localhost:$(BENCH_WEB_PORT) --incidents 200 --duplicates 3 --concurrency 8

bench-outage:  ## stop the web app, keep firing incidents, restart, count what arrived
	python bench/outage_drill.py --web http://localhost:$(BENCH_WEB_PORT) --incidents 50 --down-seconds 20

bench-down:
	docker compose -p linewatch-bench down -v
