# `push-sandbox` — the CLI's opt-in local Docker exec sandbox (cli/tools.ts).
#
# Node 24 here matches the repo-wide floor (root package.json `engines`,
# .nvmrc, CI). Unlike Dockerfile.sandbox / sandbox/app.py — which follow the
# Cloudflare sandbox base image's Node (v22.23.1 today) and must move together —
# this image has a clean base and serves the CLI, where Node 24 is already
# required.
FROM python:3.14-slim-bookworm

RUN apt-get update && apt-get install -y \
    git \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN pip install ruff pytest

WORKDIR /workspace

RUN git config --global user.email "sandbox@push.app" && \
    git config --global user.name "Push User"

CMD ["tail", "-f", "/dev/null"]