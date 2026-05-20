# Contributing to KubeAtlas

Thanks for taking the time to look. This repository is the **demo-day public
release** — a snapshot intended for showcase and review. Contributions are
welcome, but please read this document first; the project is small and
deliberately scoped, and some changes are easier to land than others.

## Quick development loop

Prerequisites: **Go ≥ 1.24** and a reachable Kubernetes cluster via your
local kubeconfig (kind, minikube, k3d, or a real cluster you trust).

```bash
make run     # hot-reload dev server via air → http://127.0.0.1:8000
make build   # produces ./bin/kubeatlas
make lint    # golangci-lint (must pass before submitting a PR)
make stop    # stop the dev server started by `make run`
go test ./...
```

The frontend has no build step — edit files under `public/` and reload the
browser.

## Before opening a pull request

1. Run `make lint` and `go test ./...` locally; both must be clean.
2. Keep changes focused. One logical change per PR.
3. If you touched the public API surface (HTTP endpoints, SSE protocol, exec
   WebSocket framing, env-var configuration), update the README's
   "HTTP endpoints" / "Configuration" sections in the same PR.
4. New tests should sit next to the code they exercise (`*_test.go`).
   Behavioural HTTP tests use the `MockKubeService` pattern in
   `server/routes_sse_test.go`.
5. Avoid introducing new runtime dependencies on the frontend — vendored
   libraries live under `public/ext/`, and we'd like to keep that list short.

## Things that are deliberately out of scope

Some changes will be declined regardless of implementation quality, because
they conflict with the project's threat model or scope:

- Built-in authentication, user accounts, or session storage.
- Multi-cluster fan-in (one binary, one context at a time, by design).
- Dangerous operations: drain, cordon, bulk delete, node operations.
- Listening on non-loopback interfaces without the existing warning path.

If you're not sure whether an idea fits, open an issue first and ask.

## Reporting bugs

Use the bug-report issue template. A reproducible case against a kind or
minikube cluster is much easier to act on than a description against a
proprietary cloud cluster.

## Security issues

**Do not open a public issue for security vulnerabilities.** Follow
[SECURITY.md](SECURITY.md) instead.

## Licence

By contributing, you agree that your contributions will be licensed under
the same [MIT licence](LICENSE) as the rest of the project.
