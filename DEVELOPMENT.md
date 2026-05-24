# Development

Everything you need to hack on KubeAtlas. For what KubeAtlas *is*, see the [README](README.md).

## Prerequisites

- **Go ≥ 1.24** — the only hard requirement to build and run.
- For the throwaway test clusters: [`kwokctl` + `kwok`](https://kwok.sigs.k8s.io/) and `kubectl`.
- For regenerating raster brand assets (`make brand-png`): `rsvg-convert` (librsvg), ImageMagick, and `python3` with `fonttools`.

Pinned dev tooling (golangci-lint, air) is vendored via `.dev/tools.mod` and invoked through `go tool` — nothing to install globally.

Prefer a turnkey setup? Open the repo in the bundled **devcontainer** (`.devcontainer/`), which pins Go, air, golangci-lint, kubectl, KWOK, and the brand-png tools.

## Platform support

The compiled binary is fully cross-platform — CI builds and tests it on Linux, macOS, and Windows (amd64 + arm64). The `make`-based dev workflow is **bash + GNU make**, so:

- **Linux** — everything works.
- **macOS** — `make run` / `dev` / `build` / `lint` and the seed clusters work; install `kwokctl`/`kubectl` (and, for `make brand-png`, `librsvg` + `imagemagick` + `fonttools`) via Homebrew, with Docker running. `make stop` is Linux-only (it reads `/proc`) — use Ctrl-C or `kill` instead.
- **Windows** — the bash/make targets don't run in cmd/PowerShell. Use the **devcontainer** (Docker Desktop) or **WSL2** for the same Linux toolchain.

The devcontainer is the lowest-friction path on any host — it bundles the entire toolchain.

## Run the dev server

```bash
make dev        # spin up a throwaway KWOK cluster + hot-reload dev server (zero host setup)
make run        # hot-reload dev server (via air) against your current kubeconfig context
make dev-down   # delete the throwaway KWOK cluster
make stop       # stop ONLY this repo's air/tmp/main (Linux-only)
```

`make dev` provisions an in-process KWOK cluster (`kwok-kubeatlas-dev`) using kwokctl's **binary** runtime — no Docker-in-Docker — so a clone goes straight to a live server. Both `make dev` and `make run` set `STATIC_DIR=public`, so the frontend is served from disk: edit anything under `public/` and reload the browser, no rebuild.

The server listens on http://127.0.0.1:8000. Configuration (env vars) is documented in the [README](README.md#quick-start).

## Build, test, lint

```bash
make build      # self-contained ./bin/kubeatlas (frontend embedded via go:embed)
go test ./...   # all Go tests
go test ./server -run TestName   # a single test
make lint       # golangci-lint (must pass for PRs)
make lint-fix   # lint with --fix
```

A built binary leaves `STATIC_DIR` unset and serves the embedded copy of `public/`, so it runs anywhere a kubeconfig is reachable — no sidecar files.

## Test clusters

Purpose-built [KWOK](https://kwok.sigs.k8s.io/)-simulated clusters that seed in about a minute and need no real infrastructure. Each is its own kwok cluster + kubeconfig context; switch to it and run `make run` (or `make build && ./bin/kubeatlas`) against it.

```bash
make seed-large-prod        # kubeatlas-test-large-prod  — realistic ~19 nodes / ~130 pods,
                            #   mixed workload kinds, PVCs, sidecars, live metrics, all four edge types
make seed-large-incident    # kubeatlas-test-large-incident — ~6 nodes / ~28 pods, deliberately broken:
                            #   CrashLoop, OOMKilled, ImagePullBackOff, Pending, stuck-Terminating,
                            #   a NotReady node — each failure pinned by a label-keyed KWOK Stage so
                            #   it does not self-heal during a walkthrough
make teardown-large-prod
make teardown-large-incident
```

The KWOK startup configs they pass to `kwokctl` (metrics, usage tiers, incident stages) live under `.dev/kwok/`.

```bash
# typical loop
make seed-large-prod
kubectl config use-context kubeatlas-test-large-prod
make run
# …then when done
make teardown-large-prod
```

## Brand assets

The vector brand sources live in `public/img/brand/` (logos, wordmarks, lockups — all zero-margin, text outlined). The raster assets (icons, social card, favicon) are generated from them:

```bash
make brand-png   # regenerate apple-touch-icon.png, maskable-512.png, og-card.png, favicon.ico
```

See `scripts/gen-brand-png.sh` for how the pipeline renders SVG text in real Inter via a throwaway fontconfig env.

## Releases

```bash
make release-snapshot   # cross-compile a local GoReleaser snapshot into dist/ (no publish)
```

Pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml` → GoReleaser cross-compiles linux/darwin/windows × amd64/arm64 archives + checksums and attaches them to the GitHub Release. Every PR additionally cross-compiles all six targets and runs the test suite on ubuntu/macOS/Windows as a guard (`.github/workflows/ci.yml`).
