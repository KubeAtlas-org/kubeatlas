# Security policy

## Scope and threat model

KubeAtlas is **local-only by default**. It binds `127.0.0.1`, uses the
kubeconfig user's RBAC as its sole authorization boundary, and assumes a
trusted operator on a trusted machine. Do not expose KubeAtlas to a network.

See the "Security model" section of the [README](README.md) for the full
posture (DNS-rebinding mitigation, `X-Client-ID` requirement on mutating
routes, slowloris timeout, server-side redaction of Secret/ConfigMap `data`).

## Supported versions

KubeAtlas is in an early public-release phase. Security fixes are applied to
the latest tagged release on `main`. Older tags are not patched.

## Reporting a vulnerability

If you believe you have found a security issue, please **do not open a public
GitHub issue**. Instead, email the maintainers at:

**ahkademirci@gmail.com**

Please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept if you have one.
- The KubeAtlas commit or release version.
- Your kubeconfig context type (kind, minikube, EKS, etc.) if relevant.

We aim to acknowledge new reports within **72 hours** and to provide an
initial assessment within **7 days**. Coordinated disclosure timelines will
be agreed with the reporter on a case-by-case basis.

## Out of scope

- Issues that require running KubeAtlas exposed on a non-loopback interface
  against the maintainers' explicit guidance.
- Findings against the vendored frontend libraries in `public/ext/` — please
  report those upstream.
- Denial-of-service against a local single-user binary.
