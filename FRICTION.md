# Friction log

Rough edges hit while building Linewatch, in the order they happened. Kept honestly, because
noticing friction is the job.

| When | What happened | What I did |
| --- | --- | --- |
| Setup | `pip install` on Ubuntu 24.04 refuses system-wide installs (PEP 668). | Used a venv. Obvious in hindsight; the quickstart could mention it. |
| Setup | `inference-cli 1.8.0` crashes on import with the latest `supervision 0.31.0`: it still imports `sv.ByteTrack`, which 0.31 removed. A fresh `pip install inference-cli inference-sdk supervision` is broken. | Pinned `supervision<0.30` here, and opened [roboflow/inference#3217](https://github.com/roboflow/inference/pull/3217) to cap supervision in the CLI's own requirements. |
| SDK | `inference-sdk` warns that the API key is sent in the query string by default. | Opted in with `InferenceConfiguration(api_key_transport="header")`. |
| Models | The first Universe PPE model I tried (`ppe-bacnb/1`) returned zero detections on an obvious orange vest. | Wrote `eval/compare_models.py` to compare models on my own clips before choosing. |
| Models | `personal-protective-equipment-combined-model/8` finds vests but never returned a `Person` box on my footage. | Split the job: a COCO person model plus a PPE model, in parallel. |
| Models | On a high CCTV-style angle, the PPE model found 0 to 2 of about 8 to 9 visible workers. | Compared COCO person models at larger input; RF-DETR small found the most people on my clips. |
| Rules | Vest detections flicker, so a worker in a vest got flagged and the same people re-fired. | Majority window per tracked person, lower vest threshold than person threshold, 60 s cooldown per person. |
| Docs | The single-image upload REST endpoint wasn't on the docs pages I found. | Read the `roboflow-python` source (`adapters/rfapi.py`) and mirrored its request. |
| Web | The zone editor's frame image could load before React hydrated, so `onLoad` never fired and the editor waited forever. | Check `img.complete` on mount. Caught by an end-to-end browser test. |
| Eval | My first precision run said 100 of 100 incidents were real. The clips are about 6 s long and loop, so the same few people were flagged on every loop, and the API capped the list at 100. | Added `FRAME_STRIDE` for one repeatable pass per clip, removed the cap, reset and re-reviewed: 19 of 22. |
| Tracking | On the high-camera clip ByteTrack handed out 128 IDs in 175 frames, and each new ID raised a fresh incident for the same worker (49 incidents). | A track that fires near a live incident joins it: 49 to 20 on the same frames. |
