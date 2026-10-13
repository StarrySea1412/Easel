ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG PYTHON_IMAGE=python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2
FROM ${PYTHON_IMAGE} AS apt-trust
FROM ${NODE_IMAGE} AS frontend
WORKDIR /build
COPY web/frontend/package*.json ./
RUN npm ci
COPY web/frontend/ ./
COPY skills/ /skills/
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /runtime
COPY --from=apt-trust /etc/ssl/certs/ /etc/ssl/certs/
RUN sed -i 's|http://deb.debian.org|https://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
COPY deployment/138/runtime-package.json ./package.json
COPY deployment/138/runtime-package-lock.json ./package-lock.json
RUN npm ci --omit=dev && npm cache clean --force

FROM ${PYTHON_IMAGE}
ARG EASEL_RELEASE_SHA
LABEL org.opencontainers.image.revision=${EASEL_RELEASE_SHA}
ENV PYTHONUNBUFFERED=1 PYTHONUTF8=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/chromium HOME=/home/easel \
    EASEL_NODE_EXECUTABLE=/usr/local/bin/node \
    EASEL_OPENCLAW_ENTRY=/opt/openclaw/node_modules/openclaw/openclaw.mjs \
    PYTHONPATH=/app:/app/web:/app/skills/shared/scripts
RUN sed -i 's|http://deb.debian.org|https://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libgl1 libglib2.0-0 git ca-certificates bash tini fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 easel && useradd --uid 1000 --gid easel --create-home easel
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /runtime/ /opt/openclaw/
RUN ln -s /opt/openclaw/node_modules/openclaw/openclaw.mjs /usr/local/bin/openclaw
WORKDIR /app
COPY pyproject.toml ./
COPY easel/ ./easel/
COPY requirements/linux-py312.lock /tmp/requirements.lock
RUN pip install --no-cache-dir -r /tmp/requirements.lock \
    && python -m playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.cache
COPY web/ ./web/
COPY scripts/ ./scripts/
COPY skills/ ./skills/
COPY profiles/_template/ ./profiles/_template/
COPY openclaw/workspace/ ./openclaw/workspace/
COPY LICENSE ./
COPY release-manifest.json ./
COPY deployment/138/ ./deployment/138/
COPY --from=frontend /build/dist/ ./web/frontend/dist/
RUN pip install --no-deps . \
    && rm -rf web/frontend/node_modules \
    && ln -s /data/.env .env && ln -s /data/outputs outputs \
    && chmod -R a+rX /opt/chromium /app /opt/openclaw
USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "/app/deployment/138/supervisor.py"]
