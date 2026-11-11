# Chế độ máy chủ của Confluence → Markdown. Hướng dẫn: DEPLOY.md
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 PATH="/app/.venv/bin:$PATH"

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev

RUN useradd --create-home --uid 10001 app && mkdir -p /data && chown app /data
USER app
ENV CME_GUI_DATA_DIR=/data HOME=/home/app
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,os; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8080'))"
CMD ["cme-gui", "--server"]
