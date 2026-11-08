#!/usr/bin/env python3
"""OpenAI-compatible TTS HTTP server with two interchangeable backends.

Backends
--------
``piper``  Fully offline Chinese TTS (``zh_CN-huayan-medium``, 22.05 kHz WAV).
           Piper ships its own Chinese front end (``piper.phonemize_chinese``),
           so Mandarin reads correctly with no network access at all.
``edge``   Microsoft Edge's consumer read-aloud endpoint via the ``edge-tts``
           package (MP3, 24 kHz). Requires outbound network; markedly better on
           mixed Chinese/English narration (ASR-verified).

Both are exposed behind the exact HTTP contract OpenMAIC already speaks for its
built-in local TTS slot::

    POST /v1/audio/speech   {"model","input","voice","speed","response_format"}
    GET  /v1/models
    GET  /health

OpenMAIC reaches this through ``TTS_LEMONADE_BASE_URL`` (see
``lib/server/provider-config.ts`` resolveTTSBaseUrl + ``lib/audio/tts-providers.ts``
generateLemonadeTTS), so no application source change is required.

Why two backends exist
----------------------
Lemonade's Kokoro backend phonemizes Chinese with espeak-ng's ``cmn`` front end,
but the ``z*`` Kokoro voices were trained on the misaki-zh phoneme set. The two
do not match, so Chinese came out as "sounds like Mandarin, but every syllable
is the wrong word" (verified by ASR). That mismatch lives inside Lemonade's
``koko`` binary and cannot be fixed by configuration. Piper replaced it as the
offline path; edge-tts then won on mixed CN/EN quality and became the
server-side default, leaving Piper as the offline fallback.

Deployment shape
----------------
One image, two services (see ``docker-compose.override.yml`` at the repository
root, merged automatically)::

    piper-tts   :8090   --backend piper   (offline, opt-in profile tts-fallback)
    edge-tts    :8091   --backend edge    (server-side default)

Only the edge service starts with a plain ``up``. Piper sits behind the
``tts-fallback`` compose profile because nothing ever called it automatically:
both generation paths resolve a single provider for the TTS slot and have no
failover, so it only ever answered its own health check. It is also a poor
stand-in for narration in delivery — its Chinese G2P misreads technical terms
(``BM25`` comes out as "LM25") — so an edge outage needs a cloud TTS provider,
not this backend.

The requested ``voice`` is honoured by the edge backend, which has hundreds of
neural voices upstream and picks per request, so one container can serve any
``zh-CN-*-Neural`` id (this is what lets a customer choose a voice per order).
The piper backend serves its single bundled ``.onnx`` voice and therefore
ignores the field — the log says so when it happens.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import logging
import re
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

LOG = logging.getLogger("tts-shim")

# -- backend selection (set in main()) -------------------------------------
BACKEND = "piper"
VOICE_NAME = ""
VOICE: Any = None  # PiperVoice when BACKEND == "piper", else unused

EDGE_VOICE = "zh-CN-XiaoxiaoNeural"
# Shape of an Azure/edge neural voice id, e.g. `zh-CN-YunxiNeural`. Requests are
# checked against this before the value reaches the upstream service, so the
# shim never forwards arbitrary caller-supplied strings.
EDGE_VOICE_RE = re.compile(r"^[a-z]{2,3}-[A-Z]{2}(?:-[A-Za-z]{2,8})?-[A-Za-z]{2,20}Neural$")
EDGE_TIMEOUT_S = 90.0
EDGE_RETRIES = 3

# Synthesis is CPU bound (piper) or rate limited upstream (edge): serialise so
# concurrent requests cannot thrash the CPU or trip Microsoft's throttling.
VOICE_LOCK = threading.Lock()
_last_reported_voice: str | None = None

MAX_INPUT_CHARS = 4000

CONTENT_TYPES = {"piper": "audio/wav", "edge": "audio/mpeg"}


# -- piper backend ----------------------------------------------------------
def synth_piper_wav(text: str, speed: float) -> bytes:
    """Synthesize ``text`` and return complete RIFF/WAVE bytes (16-bit PCM)."""
    from piper import SynthesisConfig  # lazy: the edge container never loads piper

    # OpenAI encodes pace as ``speed``; Piper uses ``length_scale`` (inverse).
    safe_speed = max(0.25, min(4.0, speed or 1.0))
    syn = SynthesisConfig(length_scale=1.0 / safe_speed)

    buf = io.BytesIO()
    with VOICE_LOCK:
        with wave.open(buf, "wb") as wav_file:
            params_set = False
            for chunk in VOICE.synthesize(text, syn):
                if not params_set:
                    wav_file.setframerate(chunk.sample_rate)
                    wav_file.setsampwidth(chunk.sample_width)
                    wav_file.setnchannels(chunk.sample_channels)
                    params_set = True
                wav_file.writeframes(chunk.audio_int16_bytes)
    return buf.getvalue()


# -- edge backend -----------------------------------------------------------
def to_edge_rate(speed: float) -> str:
    """OpenAI's multiplier -> edge-tts' signed percentage (1.25 -> '+25%')."""
    safe_speed = max(0.25, min(4.0, speed or 1.0))
    return f"{int(round((safe_speed - 1.0) * 100)):+d}%"


async def _edge_synth_once(text: str, speed: float, voice: str | None = None) -> bytes:
    import edge_tts  # lazy import

    buf = bytearray()
    communicate = edge_tts.Communicate(text, voice or EDGE_VOICE, rate=to_edge_rate(speed))
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf += chunk["data"]
    if not buf:
        raise RuntimeError("edge-tts returned an empty audio stream")
    return bytes(buf)


def synth_edge_mp3(text: str, speed: float, voice: str | None = None) -> bytes:
    """Synthesize ``text`` and return a complete MP3 file (24 kHz mono).

    ``voice`` overrides the container's default for this one request; the
    caller has already validated it against :data:`EDGE_VOICE_RE`.

    The bytes are already a finished file, so no transcoding is needed:
    OpenMAIC derives the on-disk extension from the response Content-Type
    (``lib/audio/tts-providers.ts`` -> ``result.format``), and
    ``lib/video-export/archive-media.ts`` natively accepts ``audio/mpeg``.
    """
    last_exc: BaseException | None = None
    with VOICE_LOCK:
        for attempt in range(1, EDGE_RETRIES + 1):
            started = time.monotonic()
            try:
                data = asyncio.run(
                    asyncio.wait_for(_edge_synth_once(text, speed, voice), EDGE_TIMEOUT_S)
                )
                LOG.info(
                    "edge synth ok: %d chars -> %d bytes in %.2fs (attempt %d)",
                    len(text), len(data), time.monotonic() - started, attempt,
                )
                return data
            except Exception as exc:  # noqa: BLE001 - retried, then reported upstream
                last_exc = exc
                LOG.warning(
                    "edge synth attempt %d/%d failed after %.2fs: %s: %s",
                    attempt, EDGE_RETRIES, time.monotonic() - started,
                    type(exc).__name__, exc,
                )
                if attempt < EDGE_RETRIES:
                    time.sleep(1.5 * attempt)
    raise RuntimeError(f"edge-tts failed after {EDGE_RETRIES} attempts: {last_exc}")


def synth(text: str, speed: float, voice: str | None = None) -> bytes:
    """Dispatch to the configured backend. Raises on failure (never silently
    falls back to the other backend -- that would make narration language and
    timbre unpredictable).

    ``voice`` only reaches the edge backend; piper has a single bundled voice.
    """
    if BACKEND == "edge":
        return synth_edge_mp3(text, speed, voice)
    return synth_piper_wav(text, speed)


# -- HTTP layer -------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "tts-shim/2.0"

    def log_message(self, fmt: str, *args: object) -> None:  # noqa: A003
        LOG.info("%s - %s", self.address_string(), fmt % args)

    # -- helpers ----------------------------------------------------------
    def _send_bytes(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        # Content-Type is load-bearing: validateTTSAudioResponse
        # (lib/audio/tts-providers.ts) trusts any `audio/*` header outright and
        # only byte-sniffs otherwise, which misfires on valid audio.
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, code: int, obj: object) -> None:
        self._send_bytes(
            code,
            json.dumps(obj, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def _error(self, code: int, message: str, err_type: str = "invalid_request_error") -> None:
        self._send_json(code, {"error": {"message": message, "type": err_type}})

    @staticmethod
    def _norm_path(raw: str) -> str:
        path = raw.split("?", 1)[0]
        if len(path) > 1 and path.endswith("/"):
            path = path.rstrip("/")
        return path

    # -- routes -----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        path = self._norm_path(self.path)

        if path in ("/health", "/api/v1/health"):
            self._send_json(
                200, {"status": "ok", "backend": BACKEND, "voice": VOICE_NAME}
            )
        elif path in ("/v1/models", "/models"):
            # OpenMAIC's "fetch models" button on a custom provider hits this.
            self._send_json(
                200,
                {
                    "object": "list",
                    "data": [
                        {"id": VOICE_NAME, "object": "model", "owned_by": BACKEND},
                        {"id": f"tts-shim-{BACKEND}", "object": "model", "owned_by": BACKEND},
                    ],
                },
            )
        elif path == "/":
            self._send_json(
                200,
                {
                    "service": "tts-shim",
                    "backend": BACKEND,
                    "voice": VOICE_NAME,
                    "endpoints": ["/v1/audio/speech", "/v1/models", "/health"],
                },
            )
        else:
            self._error(404, f"no such endpoint: {path}", "not_found_error")

    def do_POST(self) -> None:  # noqa: N802
        global _last_reported_voice

        path = self._norm_path(self.path)
        if path not in ("/v1/audio/speech", "/audio/speech"):
            self._error(404, f"no such endpoint: {path}", "not_found_error")
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            payload = json.loads(raw or b"{}")
            if not isinstance(payload, dict):
                raise ValueError("body must be a JSON object")
        except (ValueError, json.JSONDecodeError) as exc:
            self._error(400, f"invalid JSON body: {exc}")
            return

        text = str(payload.get("input") or payload.get("text") or "").strip()
        if not text:
            self._error(400, "'input' is required and must be non-empty")
            return
        if len(text) > MAX_INPUT_CHARS:
            self._error(400, f"'input' exceeds {MAX_INPUT_CHARS} characters")
            return

        requested_voice = str(payload.get("voice") or VOICE_NAME)
        override_voice: str | None = None
        if BACKEND == "edge" and requested_voice and requested_voice != EDGE_VOICE:
            if EDGE_VOICE_RE.match(requested_voice):
                override_voice = requested_voice
            elif requested_voice != _last_reported_voice:
                # Another provider's voice id (Kokoro's `af_heart`, a catalog
                # pin, ...): keep serving the configured voice instead of
                # failing the request, but say so once per distinct value.
                _last_reported_voice = requested_voice
                LOG.info(
                    "voice %r is not an edge neural id; serving %r",
                    requested_voice, EDGE_VOICE,
                )
        elif requested_voice != VOICE_NAME and requested_voice != _last_reported_voice:
            _last_reported_voice = requested_voice
            LOG.info(
                "voice %r requested but this %s backend always serves %r",
                requested_voice, BACKEND, VOICE_NAME,
            )

        try:
            speed = float(payload.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0

        try:
            audio = synth(text, speed, override_voice)
        except Exception as exc:  # noqa: BLE001 - report upstream instead of dying
            LOG.exception("%s synthesis failed (%d chars)", BACKEND, len(text))
            self._error(500, f"{BACKEND} synthesis failed: {exc}", "server_error")
            return

        LOG.info(
            "synthesized %d chars -> %d bytes (backend=%s voice=%s speed=%.2f)",
            len(text), len(audio), BACKEND, requested_voice, speed,
        )
        self._send_bytes(200, audio, CONTENT_TYPES[BACKEND])


def main() -> None:
    global BACKEND, VOICE, VOICE_NAME, EDGE_VOICE, EDGE_TIMEOUT_S, EDGE_RETRIES

    parser = argparse.ArgumentParser(description="OpenAI-compatible TTS shim (piper | edge)")
    parser.add_argument(
        "--backend", choices=("piper", "edge"), default="piper",
        help="Synthesis backend. 'piper' is offline; 'edge' needs outbound network.",
    )
    parser.add_argument(
        "--model", default="/app/voices/zh_CN-huayan-medium.onnx",
        help="Path to the Piper .onnx voice file (piper backend only)",
    )
    parser.add_argument("--voice-name", default=None, help="Override the advertised voice id")
    parser.add_argument(
        "--edge-voice", default=EDGE_VOICE,
        help="edge-tts voice used for every request (edge backend only)",
    )
    parser.add_argument(
        "--edge-timeout", type=float, default=EDGE_TIMEOUT_S,
        help="Per-attempt timeout in seconds (edge backend only)",
    )
    parser.add_argument(
        "--edge-retries", type=int, default=EDGE_RETRIES,
        help="Attempts per request before failing (edge backend only)",
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8090)
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    BACKEND = args.backend
    EDGE_TIMEOUT_S = args.edge_timeout
    EDGE_RETRIES = args.edge_retries

    if BACKEND == "piper":
        from piper import PiperVoice

        model_path = Path(args.model)
        if not model_path.exists():
            raise SystemExit(f"voice model not found: {model_path}")

        VOICE = PiperVoice.load(model_path)
        VOICE_NAME = args.voice_name or model_path.name[: -len(".onnx")]
        LOG.info(
            "backend=piper loaded voice %s (%d Hz, %d speaker(s), espeak=%s)",
            VOICE_NAME,
            VOICE.config.sample_rate,
            VOICE.config.num_speakers,
            getattr(VOICE.config, "espeak_voice", "?"),
        )
    else:
        import edge_tts  # noqa: F401 - fail fast if the dependency is missing

        VOICE_NAME = args.edge_voice
        EDGE_VOICE = args.edge_voice
        LOG.info(
            "backend=edge voice %s (timeout %.0fs, retries %d, needs outbound network)",
            VOICE_NAME, EDGE_TIMEOUT_S, EDGE_RETRIES,
        )

    LOG.info("content-type for this backend: %s", CONTENT_TYPES[BACKEND])

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    LOG.info("listening on http://%s:%d", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOG.info("shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
