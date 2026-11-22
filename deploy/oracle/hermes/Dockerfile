# Hermes Agent with local speech-to-text (faster-whisper) for WhatsApp voice messages.
# Built by docker compose (service "hermes"); update.sh / setup-hermes.sh rebuild it with --pull,
# so every new official image gets the same addition.
#
# Why a derived image: the official image runs Hermes from a sealed venv (/opt/hermes/.venv, no
# pip) and leaves faster-whisper out. `hermes pm install --extra stt-whisper` needs pnpm, which
# the image does not ship, and with faster-whisper missing the "local" provider resolves to none,
# so Hermes never tries its own lazy install. Here the image's own pinned uv adds exactly the
# versions in the image's uv.lock ([stt-whisper] extra: faster-whisper, av, ctranslate2,
# onnxruntime, tokenizers, huggingface-hub) to that venv, prebuilt wheels only.
# The Whisper model itself is not baked in: it downloads once into HF_HOME on the data volume
# (see docker-compose.yml), so image updates never download it again.
ARG HERMES_IMAGE=nousresearch/hermes-agent:stable
FROM ${HERMES_IMAGE}

USER root
RUN set -eu; \
    uv="$(find /opt/hermes/tools -type f -name uv -perm -u+x 2>/dev/null | head -n 1)"; \
    [ -n "$uv" ] || { echo "echo-stt: Hermes imajinda uv bulunamadi (/opt/hermes/tools)" >&2; exit 1; }; \
    python=/opt/hermes/.venv/bin/python; \
    [ -x "$python" ] || { echo "echo-stt: $python yok" >&2; exit 1; }; \
    export UV_CACHE_DIR=/tmp/echo-uv-cache UV_NO_CONFIG=1 UV_PYTHON_DOWNLOADS=never UV_NO_PROGRESS=1; \
    "$uv" export --project /opt/hermes --frozen --no-emit-project --no-hashes --no-header \
        --no-annotate --extra stt-whisper --output-file /tmp/echo-stt-constraints.txt >/dev/null; \
    grep -E '^[A-Za-z0-9_.-]+==' /tmp/echo-stt-constraints.txt > /tmp/echo-stt-pins.txt; \
    grep -Eq '^faster-whisper==' /tmp/echo-stt-pins.txt \
        || { echo "echo-stt: uv.lock icinde faster-whisper yok ([stt-whisper] extra'si degismis olabilir)" >&2; exit 1; }; \
    "$uv" pip install --python "$python" --only-binary :all: --link-mode copy \
        --constraint /tmp/echo-stt-pins.txt faster-whisper av; \
    rm -rf /tmp/echo-uv-cache /tmp/echo-stt-constraints.txt /tmp/echo-stt-pins.txt; \
    "$python" -c 'import faster_whisper, ctranslate2, av, onnxruntime; print("echo-stt: faster-whisper", faster_whisper.__version__, "ctranslate2", ctranslate2.__version__)'
