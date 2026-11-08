# Local Chinese TTS shim for OpenMAIC — one image, two interchangeable backends,
# both behind the OpenAI POST /v1/audio/speech contract so that no application
# source change is required:
#
#   --backend piper  :8090   fully offline, 22.05 kHz WAV (fallback)
#   --backend edge   :8091   edge-tts, 24 kHz MP3, needs outbound network
#                            (server-side default for classroom generation)
#
# Which backend a container serves is decided by its compose `command`, not by
# this image — see deploy/tutorial-video/docker-compose.override.yml.
#
# Build context = deploy/tutorial-video/piper-tts  (kept small on purpose; the
# narration cache and other probe output stay under docs/tutorial-video/).
#
# The voice model (voices/zh_CN-huayan-medium.onnx, 61 MB) is NOT committed —
# see deploy/README.md for the download URL. Only the piper backend needs it;
# an edge-only deployment can leave the file out.
FROM python:3.13-slim

# pip index override for hosts where pypi.org is slow; defaults to upstream.
ARG PIP_INDEX_URL=https://pypi.org/simple

# piper-tts bundles its own espeak-ng data plus the Chinese front end, so no
# extra system packages are needed; edge-tts is pure Python (websocket client).
#
# edge-tts is pinned: 7.2.x is rejected by speech.platform.bing.com with a 403
# on the websocket handshake (the `Sec-MS-GEC-Version` it reports is no longer
# accepted), which surfaced as "edge synthesis failed after 3 attempts: 403".
# 7.3.1 is verified working; do not float this range without re-running a
# synthesis probe.
RUN pip install --no-cache-dir -i "$PIP_INDEX_URL" piper-tts "edge-tts==7.3.1"

WORKDIR /app
COPY server.py /app/server.py
COPY voices/ /app/voices/

# Non-fatal by design: the same image serves both backends, and the edge backend
# (the server-side default) never touches the piper model. A missing voice file
# only breaks the piper container's healthcheck, so warn loudly here instead of
# blocking an edge-only deployment.
RUN if [ -s /app/voices/zh_CN-huayan-medium.onnx ]; then \
      echo "piper voice: present"; \
    else \
      echo "WARN: voices/zh_CN-huayan-medium.onnx is missing (61 MB, not in git)."; \
      echo "      The --backend piper container will fail; edge-tts is unaffected."; \
      echo "      Download URL: see deploy/README.md"; \
    fi

# 8090 = piper, 8091 = edge. The voice file default is baked into server.py
# (--model /app/voices/zh_CN-huayan-medium.onnx); the edge backend never loads it.
EXPOSE 8090 8091

ENTRYPOINT ["python", "-u", "/app/server.py"]
