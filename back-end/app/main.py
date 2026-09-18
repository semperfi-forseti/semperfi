from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.api.v1 import (
    audit,
    auth_routes,
    engines,
    evidence,
    frontend,
    investigations,
    legal,
    legal_extra,
    reports,
)
from app.core.config import get_settings
from app.db import SessionLocal, init_db

settings = get_settings()
static_dir = Path(__file__).resolve().parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.environment in {"development", "test"}:
        await init_db()
    yield


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    openapi_url=f"{settings.api_v1_prefix}/openapi.json",
    docs_url=f"{settings.api_v1_prefix}/docs",
    redoc_url=f"{settings.api_v1_prefix}/redoc",
    lifespan=lifespan,
    description="API multi-tenant para operação jurídica, investigação OSINT lícita e cadeia de custódia digital.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "X-Correlation-Id", "X-CSRF-Token"] + (["X-Semperfi-User-Id", "X-Semperfi-Tenant-Id", "X-Semperfi-Roles"] if settings.environment in {"development", "test"} else []),
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if settings.environment == "production":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        # The legacy SPA still uses inline handlers and style attributes.
        # Keep the API restrictive while allowing the actual UI to load.
        if request.url.path.startswith("/ui/"):
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; "
                "connect-src 'self' https:; object-src 'none'; base-uri 'self'; "
                "frame-ancestors 'none'; form-action 'self'"
            )
        elif not request.url.path.startswith((f"{settings.api_v1_prefix}/docs", f"{settings.api_v1_prefix}/redoc")):
            response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    if request.url.path.startswith((f"{settings.api_v1_prefix}/auth", f"{settings.api_v1_prefix}/me", f"{settings.api_v1_prefix}/frontend")):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(Exception)
async def unhandled_exception(_: Request, __: Exception):
    return JSONResponse(status_code=500, content={"detail": "Erro interno. Consulte o identificador de correlação nos logs seguros."})


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    if request.url.path == f"{settings.api_v1_prefix}/auth/verify":
        return JSONResponse(status_code=422, content={"detail": "Informe o código de seis dígitos enviado por e-mail."},
                            headers={"Cache-Control": "no-store"})
    if request.url.path in {f"{settings.api_v1_prefix}/auth/login", f"{settings.api_v1_prefix}/auth/register"}:
        errors = [{"loc": error["loc"], "msg": error["msg"], "type": error["type"]}
                  for error in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": errors},
                            headers={"Cache-Control": "no-store"})
    return await request_validation_exception_handler(request, exc)


@app.get("/health/live", tags=["Health"])
async def liveness():
    return {"status": "ok", "service": settings.app_name}


@app.get("/health/ready", tags=["Health"])
async def readiness():
    try:
        async with SessionLocal() as session:
            await session.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse(status_code=503, content={"status": "not_ready", "database": "unavailable"})
    return {"status": "ready", "environment": settings.environment, "database": "ok"}


if static_dir.exists():
    app.mount("/ui", StaticFiles(directory=static_dir), name="ui")


@app.get("/", include_in_schema=False)
async def root():
    modular_frontend = static_dir / "frontend" / "index.html"
    if modular_frontend.exists():
        return RedirectResponse("/ui/frontend/index.html", status_code=307)
    return JSONResponse(status_code=404, content={"detail": "Frontend não encontrado. Execute npm run sync:backend no frontend."})


for router in (auth_routes.router, legal.router, legal_extra.router, investigations.router, engines.router, evidence.router, reports.router, audit.router, frontend.router):
    app.include_router(router, prefix=settings.api_v1_prefix)
