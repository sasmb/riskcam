from __future__ import annotations

import asyncio
import base64
import hmac
import ipaddress
import logging
import os
import socket
from io import BytesIO
from typing import Annotated
from urllib.parse import urlsplit

import cv2
import httpx
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, Field, HttpUrl
from pyzbar.pyzbar import decode as decode_barcodes
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("riskcam-vlm")

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_REQUEST_BYTES = 16 * 1024
MAX_IMAGE_EDGE = 2400
DEFAULT_SHARPNESS_THRESHOLD = 100.0

Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


class AnalyzePackagingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_url: HttpUrl = Field(max_length=4096)
    reference_image_url: HttpUrl | None = Field(default=None, max_length=4096)


class PackagingExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_name: str | None = Field(description="Visible product name, or null if unreadable.")
    active_ingredients: list[str] = Field(description="Visible active ingredients and strengths.")
    manufacturer: str | None = Field(description="Visible manufacturer, or null if unreadable.")
    registration_number: str | None = Field(description="Visible NAFDAC registration number, or null.")
    batch_number: str | None = Field(description="Visible batch or lot number, or null.")
    manufacture_date: str | None = Field(description="Manufacture date as YYYY-MM-DD when unambiguous, otherwise null.")
    expiry_date: str | None = Field(description="Expiry date as YYYY-MM-DD when unambiguous, otherwise null.")
    shelf_life_months: int | None = Field(description="Printed shelf life in months when explicit, otherwise null.")
    visual_flags: list[str] = Field(description="Visible packaging concerns such as broken seals, altered print, spelling errors, or unusual label placement. Do not infer hidden facts.")
    visual_match_probability: float | None = Field(ge=0, le=1, description="Estimated visual similarity to the supplied genuine reference image; null if no reference was supplied.")
    visual_differences: list[str] = Field(description="Visible differences from the reference packaging, or an empty list if none or no reference was supplied.")


class BarcodeResult(BaseModel):
    value: str
    format: str


class AnalyzePackagingResponse(PackagingExtraction):
    barcode: str | None
    barcode_format: str | None
    sharpness_score: float = Field(ge=0)
    is_blurry: bool


class AnalyzePackagingGuardMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] != "POST"
            or scope["path"].rstrip("/") != "/analyze-packaging"
        ):
            await self.app(scope, receive, send)
            return

        headers = dict(scope["headers"])
        expected_secret = os.getenv("VLM_WORKER_SECRET", "")
        provided_secret = headers.get(b"x-worker-secret", b"").decode("latin-1")
        if len(expected_secret) < 16:
            await self._reject(scope, receive, send, 503, "worker_secret_not_configured")
            return
        if not provided_secret or not hmac.compare_digest(provided_secret, expected_secret):
            await self._reject(scope, receive, send, 401, "unauthorized")
            return

        content_length = headers.get(b"content-length")
        if content_length:
            try:
                declared_length = int(content_length)
            except ValueError:
                await self._reject(scope, receive, send, 400, "invalid_content_length")
                return
            if declared_length < 0 or declared_length > MAX_REQUEST_BYTES:
                await self._reject(scope, receive, send, 413, "request_too_large")
                return

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > MAX_REQUEST_BYTES:
                await self._reject(scope, receive, send, 413, "request_too_large")
                return
            if not message.get("more_body", False):
                break

        body_bytes = bytes(body)
        body_replayed = False

        async def replay_body() -> Message:
            nonlocal body_replayed
            if body_replayed:
                return await receive()
            body_replayed = True
            return {"type": "http.request", "body": body_bytes, "more_body": False}

        await self.app(scope, replay_body, send)

    @staticmethod
    async def _reject(
        scope: Scope,
        receive: Receive,
        send: Send,
        status_code: int,
        detail: str,
    ) -> None:
        response = JSONResponse(status_code=status_code, content={"detail": detail})
        await response(scope, receive, send)


app = FastAPI(
    title="RiskCam packaging screening worker",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.add_middleware(AnalyzePackagingGuardMiddleware)


def require_worker_secret(
    provided_secret: Annotated[str | None, Header(alias="X-Worker-Secret")] = None,
) -> None:
    expected_secret = os.getenv("VLM_WORKER_SECRET", "")
    if len(expected_secret) < 16:
        raise HTTPException(status_code=503, detail="worker_secret_not_configured")
    if not provided_secret or not hmac.compare_digest(provided_secret, expected_secret):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/healthz")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.post(
    "/analyze-packaging",
    response_model=AnalyzePackagingResponse,
    dependencies=[Depends(require_worker_secret)],
)
async def analyze_packaging(payload: AnalyzePackagingRequest) -> AnalyzePackagingResponse:
    try:
        primary_bytes = await download_image(str(payload.image_url))
        primary_image, primary_jpeg = validate_and_prepare_image(primary_bytes)
        reference_jpeg: bytes | None = None
        if payload.reference_image_url:
            reference_bytes = await download_image(str(payload.reference_image_url))
            _, reference_jpeg = validate_and_prepare_image(reference_bytes)

        sharpness_score = calculate_sharpness(primary_image)
        threshold = float(os.getenv("VLM_SHARPNESS_THRESHOLD", DEFAULT_SHARPNESS_THRESHOLD))
        barcode = decode_barcode(primary_image)
        extraction = await extract_packaging(
            primary_jpeg,
            reference_jpeg,
            barcode,
            sharpness_score,
            threshold,
        )
        return AnalyzePackagingResponse(
            **extraction.model_dump(),
            barcode=barcode.value if barcode else None,
            barcode_format=barcode.format if barcode else None,
            sharpness_score=round(sharpness_score, 2),
            is_blurry=sharpness_score < threshold,
        )
    except HTTPException:
        raise
    except Exception as error:  # Provider failures and malformed images become a safe API error.
        logger.exception("Packaging analysis failed: %s", type(error).__name__)
        raise HTTPException(status_code=502, detail="packaging_analysis_failed") from error


async def download_image(image_url: str) -> bytes:
    validate_image_url(image_url)
    timeout = httpx.Timeout(20.0, connect=5.0)
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        trust_env=False,
        headers={"accept": "image/jpeg,image/png,image/webp"},
    ) as client:
        async with client.stream("GET", image_url) as response:
            if response.status_code != 200:
                raise HTTPException(status_code=422, detail="image_download_failed")
            content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
            if content_type not in {"image/jpeg", "image/png", "image/webp"}:
                raise HTTPException(status_code=415, detail="unsupported_image_type")
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > MAX_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="image_too_large")

            chunks = bytearray()
            async for chunk in response.aiter_bytes():
                chunks.extend(chunk)
                if len(chunks) > MAX_IMAGE_BYTES:
                    raise HTTPException(status_code=413, detail="image_too_large")
            return bytes(chunks)


def validate_image_url(image_url: str) -> None:
    parts = urlsplit(image_url)
    host = parts.hostname
    if (
        parts.scheme != "https"
        or not host
        or parts.username
        or parts.password
        or parts.fragment
        or parts.port not in (None, 443)
    ):
        raise HTTPException(status_code=422, detail="invalid_image_url")

    allowlist = {
        entry.strip().lower()
        for entry in os.getenv("VLM_ALLOWED_IMAGE_HOSTS", "").split(",")
        if entry.strip()
    }
    hostname = host.lower().rstrip(".")
    allowed_domain = hostname == "amazonaws.com" or hostname.endswith(".amazonaws.com")
    if not allowed_domain and hostname not in allowlist:
        raise HTTPException(status_code=422, detail="image_host_not_allowed")

    try:
        addresses = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise HTTPException(status_code=422, detail="image_host_unavailable") from error
    if not addresses:
        raise HTTPException(status_code=422, detail="image_host_unavailable")
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise HTTPException(status_code=422, detail="image_host_not_public")


def validate_and_prepare_image(image_bytes: bytes) -> tuple[np.ndarray, bytes]:
    if not image_bytes:
        raise HTTPException(status_code=422, detail="empty_image")
    try:
        with Image.open(BytesIO(image_bytes)) as source:
            if source.format not in {"JPEG", "PNG", "WEBP"}:
                raise HTTPException(status_code=415, detail="unsupported_image_type")
            if source.width * source.height > MAX_IMAGE_PIXELS:
                raise HTTPException(status_code=413, detail="image_dimensions_too_large")
            source.verify()
        with Image.open(BytesIO(image_bytes)) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
            output = BytesIO()
            image.save(output, format="JPEG", quality=90, optimize=True)
            normalized_bytes = output.getvalue()
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=422, detail="invalid_image_data") from error

    encoded = np.frombuffer(normalized_bytes, dtype=np.uint8)
    decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if decoded is None:
        raise HTTPException(status_code=422, detail="invalid_image_data")
    return decoded, normalized_bytes


def calculate_sharpness(image: np.ndarray) -> float:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def decode_barcode(image: np.ndarray) -> BarcodeResult | None:
    try:
        symbols = decode_barcodes(Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)))
    except Exception as error:
        logger.warning("Barcode decoder unavailable: %s", type(error).__name__)
        return None
    if not symbols:
        return None
    symbol = symbols[0]
    try:
        value = symbol.data.decode("utf-8").strip()
    except UnicodeDecodeError:
        value = symbol.data.hex()
    return BarcodeResult(value=value[:256], format=str(symbol.type)[:64])


async def extract_packaging(
    primary_jpeg: bytes,
    reference_jpeg: bytes | None,
    barcode: BarcodeResult | None,
    sharpness_score: float,
    sharpness_threshold: float,
) -> PackagingExtraction:
    provider = os.getenv("VLM_PROVIDER", "openai").strip().lower()
    prompt = (
        "Screen the supplied medicine package photo. Extract only text that is visible. "
        "Do not infer or invent unreadable values: use null for unknown scalar fields and an empty "
        "list for unknown lists. Normalize unambiguous dates to YYYY-MM-DD. Identify visible signs "
        "of tampering, poor print, spelling errors, seal damage, or label inconsistencies in "
        "visual_flags. A barcode decoded by the local scanner is included as evidence, not proof. "
        "If a second image is supplied, compare visible package design and report a cautious "
        "similarity probability and concrete differences. This is a screening task, not an "
        "authenticity guarantee."
    )
    context = (
        f"Locally decoded barcode: {barcode.value if barcode else 'not detected'} "
        f"({barcode.format if barcode else 'n/a'}). "
        f"Sharpness score: {sharpness_score:.2f}; blurry threshold: {sharpness_threshold:.2f}. "
        f"Reference image supplied: {'yes' if reference_jpeg else 'no'}."
    )

    if provider == "openai":
        return await call_openai(prompt, context, primary_jpeg, reference_jpeg)
    if provider == "gemini":
        return await call_gemini(prompt, context, primary_jpeg, reference_jpeg)
    raise HTTPException(status_code=503, detail="unsupported_vlm_provider")


async def call_openai(
    prompt: str,
    context: str,
    primary_jpeg: bytes,
    reference_jpeg: bytes | None,
) -> PackagingExtraction:
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="openai_api_key_not_configured")

    from openai import AsyncOpenAI

    image_parts: list[dict[str, object]] = [
        {
            "type": "image_url",
            "image_url": {
                "url": jpeg_data_url(primary_jpeg),
                "detail": "high",
            },
        }
    ]
    if reference_jpeg:
        image_parts.append(
            {
                "type": "image_url",
                "image_url": {
                    "url": jpeg_data_url(reference_jpeg),
                    "detail": "high",
                },
            }
        )
    client = AsyncOpenAI(api_key=api_key, timeout=90.0, max_retries=1)
    completion = await client.beta.chat.completions.parse(
        model=os.getenv("OPENAI_VLM_MODEL", "gpt-4o"),
        messages=[
            {"role": "system", "content": prompt},
            {
                "role": "user",
                "content": [{"type": "text", "text": context}, *image_parts],
            },
        ],
        response_format=PackagingExtraction,
        temperature=0,
    )
    parsed = completion.choices[0].message.parsed
    if parsed is None:
        raise RuntimeError("OpenAI returned no structured packaging result")
    return parsed


async def call_gemini(
    prompt: str,
    context: str,
    primary_jpeg: bytes,
    reference_jpeg: bytes | None,
) -> PackagingExtraction:
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="gemini_api_key_not_configured")

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    content: list[object] = [
        prompt,
        context,
        types.Part.from_bytes(data=primary_jpeg, mime_type="image/jpeg"),
    ]
    if reference_jpeg:
        content.append(types.Part.from_bytes(data=reference_jpeg, mime_type="image/jpeg"))

    response = await asyncio.to_thread(
        client.models.generate_content,
        model=os.getenv("GEMINI_MODEL", "gemini-2.5-pro"),
        contents=content,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=PackagingExtraction,
            temperature=0,
        ),
    )
    if not response.text:
        raise RuntimeError("Gemini returned no structured packaging result")
    return PackagingExtraction.model_validate_json(response.text)


def jpeg_data_url(image_bytes: bytes) -> str:
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"
