# KubeAtlas development container.
# Pins the full toolchain so `clone → working cluster + live server` is one step,
# independent of what's installed on the host. The image is for development only;
# release artifacts are cross-compiled by GoReleaser (see .goreleaser.yaml).
FROM mcr.microsoft.com/devcontainers/go:1.24-bookworm

# Pinned for reproducibility — bump deliberately.
ENV KWOK_VERSION=v0.7.0 \
    KUBECTL_VERSION=v1.31.0

# figlet — makefile banner targets (tolerates absence, kept for identical output).
# librsvg2-bin (rsvg-convert) + imagemagick + python3-fonttools/-brotli — the
# `make brand-png` raster pipeline, so it runs inside the container too.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        figlet librsvg2-bin imagemagick python3 python3-fonttools python3-brotli \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# kubectl + KWOK (kwok/kwokctl), architecture-aware so the image builds on
# amd64 and arm64 hosts alike. kwokctl's "binary" runtime needs no Docker-in-Docker.
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
    && curl -fsSL -o /usr/local/bin/kwok    "https://github.com/kubernetes-sigs/kwok/releases/download/${KWOK_VERSION}/kwok-linux-${arch}" \
    && curl -fsSL -o /usr/local/bin/kwokctl "https://github.com/kubernetes-sigs/kwok/releases/download/${KWOK_VERSION}/kwokctl-linux-${arch}" \
    && chmod +x /usr/local/bin/kubectl /usr/local/bin/kwok /usr/local/bin/kwokctl
