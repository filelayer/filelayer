# The container one run's agent works in. Node.js 22, git, and Claude Code
# at the version PREREG.md fixes. Nothing of the benchmark is in the image:
# the harness copies in the contract, the smoke test and, for task 3, the
# seeded reference, at the start of each task.
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force
RUN useradd -m -s /bin/bash agent && mkdir -p /work/app && chown -R agent:agent /work
USER agent
WORKDIR /work/app
