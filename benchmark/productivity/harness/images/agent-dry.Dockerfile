# The rehearsal's agent image: the real one's base and user, with
# fake-claude.mjs installed as `claude`. Used only by run.mjs --dry-run.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*
COPY fake-claude.mjs /usr/local/bin/claude
RUN chmod 755 /usr/local/bin/claude
RUN useradd -m -s /bin/bash agent && mkdir -p /work/app && chown -R agent:agent /work
USER agent
WORKDIR /work/app
