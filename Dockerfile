FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y \
    git \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN pip install ruff pytest

WORKDIR /workspace

RUN git config --global user.email "sandbox@push.app" && \
    git config --global user.name "Push User"

CMD ["tail", "-f", "/dev/null"]