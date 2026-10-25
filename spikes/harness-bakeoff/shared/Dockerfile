# The Linux box the Think and Pi arms run their tools in. Build context is
# spikes/harness-bakeoff/ so the fixture can be baked in.
# cloudflare/debian-trixie is resolved by the platform for container.start(),
# not pullable from Docker Hub, so a Dockerfile builds on a public base.
FROM node:24-trixie-slim
# Helper for @cloudflare/sandbox's Files class; the tag must match the
# installed package version or calls fail with SandboxProtocolError.
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY fixture /fixture
# Each run copies /fixture to a fresh /workspace and commits it, so `git diff`
# afterwards shows exactly what the agent changed.
RUN printf '%s\n' \
      'set -e' \
      'rm -rf /workspace && cp -r /fixture /workspace && cd /workspace' \
      'git init -q -b main && git -c user.name=bakeoff -c user.email=bakeoff@invalid add -A' \
      'git -c user.name=bakeoff -c user.email=bakeoff@invalid commit -qm fixture' \
      > /usr/local/bin/reset-workspace && chmod +x /usr/local/bin/reset-workspace
ENTRYPOINT ["sleep", "infinity"]
