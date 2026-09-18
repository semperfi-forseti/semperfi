from __future__ import annotations

from app.core.config import get_settings

try:
    from celery import Celery
except ImportError:  # pragma: no cover
    Celery = None  # type: ignore

settings = get_settings()

if Celery:
    celery_app = Celery(
        "semperfi",
        broker=settings.celery_broker_url,
        backend=settings.celery_result_backend,
        include=["app.workers.tasks"],
    )
    celery_app.conf.update(
        task_default_queue="default",
        task_acks_late=True,
        worker_prefetch_multiplier=1,
        beat_schedule={
            "dispatch-transactional-outbox": {
                "task": "app.workers.tasks.dispatch_outbox_events",
                "schedule": 10.0,
            }
        },
        task_routes={
            "app.workers.tasks.*evidence*": {"queue": "critical"},
            "app.workers.tasks.*metadata*": {"queue": "cpu_heavy"},
            "app.workers.tasks.*agent*": {"queue": "agents"},
        },
    )
else:
    class _LocalTask:
        def __init__(self, fn):
            self.fn = fn

        def delay(self, *args, **kwargs):
            return type(
                "Result",
                (),
                {"id": "local-task", "get": lambda *_: self.fn(*args, **kwargs)},
            )()

        def apply_async(self, args=None, task_id=None, **kwargs):
            return type("Result", (), {"id": task_id or "local-task"})()

    class _LocalCelery:
        def task(self, *args, **kwargs):
            return lambda fn: _LocalTask(fn)

    celery_app = _LocalCelery()
