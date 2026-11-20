# Render service (src/render): studio video jobs -> MP4 with headless Chromium + ffmpeg, speech ->
# subtitles with whisper.cpp. Everything is installed here, at build time: the container has no
# internet route when it runs (compose network "render", internal), no secrets but its own bearer,
# a read-only root and a tmpfs /tmp. Multi-arch: builds on amd64 and on the Oracle arm64 VM.
# Built by docker-compose.yml (context: repo root). Only src/render and package.json are copied.

# ---- whisper.cpp (whisper-cli) and the multilingual base model (Turkish included) ----------------
FROM debian:bookworm-slim AS whisper
ARG WHISPER_VERSION=v1.9.5
ARG WHISPER_MODEL=base
# sha1 from whisper.cpp models/README.md (ggml-base.bin, 142 MiB).
ARG WHISPER_MODEL_SHA1=465707469ff3a37a2b9b8d8f89f2f99de7299dac
# ON: tuned for the CPU it is built on (the image is built on the VM it runs on). OFF for a portable build.
ARG WHISPER_NATIVE=ON
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${WHISPER_VERSION}" https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE="${WHISPER_NATIVE}" \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF \
 && cmake --build build -j"$(nproc)" --target whisper-cli \
 && strip build/bin/whisper-cli \
 && build/bin/whisper-cli --help >/dev/null
RUN curl -fsSL --retry 3 -o "/ggml-${WHISPER_MODEL}.bin" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin" \
 && echo "${WHISPER_MODEL_SHA1}  /ggml-${WHISPER_MODEL}.bin" | sha1sum -c - \
 && mv "/ggml-${WHISPER_MODEL}.bin" /ggml-model.bin

# ---- runtime ---------------------------------------------------------------------------------------
FROM node:22-bookworm-slim
# chromium + ffmpeg from Debian (both built for arm64 and amd64); Inter (Turkish glyphs), DejaVu as
# fallback, Noto Color Emoji for the template icons; libgomp1 for whisper.cpp's OpenMP threads.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ffmpeg fonts-inter fonts-dejavu-core fonts-noto-color-emoji libgomp1 \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man \
 && fc-cache -f \
 && useradd --uid 10001 --user-group --no-create-home --home-dir /tmp/home render
COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /ggml-model.bin /opt/whisper/ggml-base.bin
WORKDIR /app
COPY package.json ./
COPY src/render ./src/render
# Read-only root: everything that writes goes to /tmp (tmpfs in compose).
ENV NODE_ENV=production HOME=/tmp/home XDG_CONFIG_HOME=/tmp/home/.config XDG_CACHE_HOME=/tmp/home/.cache \
    RENDER_PORT=8092 RENDER_WORK_DIR=/tmp/render RENDER_CHROME=/usr/bin/chromium \
    RENDER_WHISPER_BIN=/usr/local/bin/whisper-cli RENDER_WHISPER_MODEL=/opt/whisper/ggml-base.bin
USER render
EXPOSE 8092
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8092/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--no-warnings", "src/render/index.js"]
