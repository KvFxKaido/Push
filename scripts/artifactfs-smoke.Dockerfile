FROM docker.io/library/python:3.11.14-slim-bookworm
COPY --from=push-artifactfs-test /go/bin/artifact-fs /usr/local/bin/artifact-fs
RUN apt-get update && apt-get install -y --no-install-recommends fuse3 git && rm -rf /var/lib/apt/lists/*
COPY sandbox/bin/push-artifactfs sandbox/bin/push-artifacts-checkpoint /usr/local/bin/
RUN chmod +x /usr/local/bin/push-artifactfs /usr/local/bin/push-artifacts-checkpoint
COPY scripts/artifactfs-smoke.sh /smoke.sh
CMD ["bash", "/smoke.sh"]
