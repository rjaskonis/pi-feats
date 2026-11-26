# syntax=docker/dockerfile:1.7
FROM docker.alphanexus.cloud/alphanexus/pi-agent-core:latest

ARG PI_FEATS_REPOSITORY=https://github.com/rjaskonis/pi-feats.git
ARG PI_FEATS_REF=main

ENV PI_CODING_AGENT_DIR=/root/.pi/agent \
    NEXT_TELEMETRY_DISABLED=1 \
    PATH="/usr/local/bin:${PATH}"

# pi-feats is the sole source of Pi extensions. Build it into the image so
# startup never needs GitHub access and the persistent volume only stores the
# package-manager installation and operational state.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    git clone "$PI_FEATS_REPOSITORY" /opt/pi-feats \
    && cd /opt/pi-feats \
    && git checkout "$PI_FEATS_REF" \
    && npm ci

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint
COPY start-pi-services.sh /usr/local/bin/start-pi-services
RUN chmod +x /usr/local/bin/docker-entrypoint /usr/local/bin/start-pi-services

# Refresh Pi even when the private base image ships an older CLI. The volume
# contains user state and must not determine which executable we launch.
ARG PI_CLI_VERSION=latest
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --global --prefix /usr/local --prefer-online --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_CLI_VERSION}" \
    && bash -lc 'test "$(command -v pi)" = /usr/local/bin/pi && pi --version'

ENTRYPOINT ["docker-entrypoint"]
CMD ["/usr/local/bin/start-pi-services"]
