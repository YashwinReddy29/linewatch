# Run from the repo root. Local (non-Docker) targets expect the venv to be active.
.PHONY: up down logs worker web test lint compare report precision eval

up:            ## everything in Docker: inference, worker, web, db
	docker compose up --build -d
	@echo "Console: http://localhost:$$(grep -s '^WEB_PORT=' .env | cut -d= -f2 || echo 3000)"

down:
	docker compose down

logs:          ## worker + web logs only (the Inference server logs every request)
	docker compose logs -f worker web

worker:        ## worker on this machine (Inference server must be running)
	PYTHONPATH=worker python -m linewatch.main

web:           ## web console in dev mode (needs Postgres; see README)
	cd web && npm run dev

test:
	cd worker && python -m pytest -q

lint:
	cd worker && ruff check linewatch tests && ruff format --check linewatch tests
	cd web && npm run typecheck

compare:       ## compare candidate models on your clips
	python eval/compare_models.py samples/street-crew.mp4 samples/two-people.mp4 samples/vests-walking.mp4 samples/site1.mp4 --frames 4 --conf 0.3

report:        ## latency and detection-rate summary of the latest worker run
	python eval/latency_report.py

precision:     ## incident precision from your reviews in the console
	python eval/review_precision.py

eval:          ## precision / recall / mAP@50 on your labeled test set
	python eval/eval_detections.py eval/testset/test
