# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/usr/local/bin:/root/.local/bin:${PATH}"

# The Debian CDN is unusually slow from the production host. The base image
# lacks CA certificates before this install, so bootstrap over HTTP; APT still
# verifies every repository Release and package signature. Keep security on its
# official source.
ARG DEBIAN_MIRROR=http://mirror.leaseweb.com/debian
RUN sed -i "s|^URIs: http://deb.debian.org/debian$|URIs: ${DEBIAN_MIRROR}|" /etc/apt/sources.list.d/debian.sources

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git rsync iputils-ping net-tools openssh-client sshpass smbclient \
    bash procps nano micro jq unzip python3 python-is-python3 \
    mariadb-client postgresql-client \
    && mariadb --version && psql --version \
    && rm -rf /var/lib/apt/lists/*

ARG GLOW_VERSION=3.0.0
RUN curl -fsSL https://nono.sh/install.sh | sh \
    && curl -sSL https://raw.githubusercontent.com/pimalaya/himalaya/master/install.sh | sh \
    && curl -fsSL "https://github.com/charmbracelet/glow/releases/download/v${GLOW_VERSION}/glow_${GLOW_VERSION}_Linux_x86_64.tar.gz" | tar -xz -C /tmp \
    && install -m 0755 "$(find /tmp -maxdepth 2 -type f -name glow | head -n1)" /usr/local/bin/glow \
    && rm -rf /tmp/glow*

# Keep the CLI outside /root/.pi, which is mounted as persistent state.
ARG PI_CLI_VERSION=latest
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --global --prefix /usr/local --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_CLI_VERSION}" \
    && bash -lc 'command -v pi && pi --version'
