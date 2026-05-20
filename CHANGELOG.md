# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-20

Initial public release — the demo-day snapshot of KubeAtlas.

### Added

- Go backend (chi, `client-go` dynamic informers, `log/slog`) serving a
  vanilla-JavaScript SPA from a single binary.
- Real-time resource tables across 17 Kubernetes kinds, live add / update /
  remove over Server-Sent Events with per-namespace fan-out and an `_all_`
  group for cluster-scoped kinds.
- Canvas2D + d3-force topology graph with semantic-zoom LOD, kind-encoded
  shapes, health-encoded colours, and edge-class filters (owner / network /
  mount / env-ref).
- Multi-container pod log streaming with follow, search/highlight,
  previous-container and timestamp toggles.
- Interactive web shell over WebSocket + xterm.js, with a three-opcode
  binary framing protocol (`frameData` / `frameResize` / `frameError`).
- Scale, rollout restart, in-browser YAML edit & apply, hold-to-confirm
  delete, kubeconfig context switching, dynamic CRD discovery.
- Pod and node CPU / memory columns via the `metrics.k8s.io` proxy.
- Local-only security posture: loopback bind by default, host-header
  validation (DNS-rebinding mitigation), `X-Client-ID` requirement on all
  mutating routes, slowloris read-header timeout, server-side redaction of
  Secret and ConfigMap `data` fields on YAML export.

[Unreleased]: https://github.com/KubeAtlas-org/kubeatlas/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/KubeAtlas-org/kubeatlas/releases/tag/v0.1.0
