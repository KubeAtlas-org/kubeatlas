#!/bin/sh
# KubeAtlas installer — downloads the latest release binary for your OS/arch,
# verifies its checksum, and drops it on your PATH.
#
#   curl -fsSL https://kubeatlas-org.github.io/kubeatlas/install.sh | bash
#
# Honest note: piping a remote script to a shell runs whatever it contains.
# Feel free to read this first (it's short), or grab the binary by hand from
# https://github.com/kubeatlas-org/kubeatlas/releases instead.
#
# Knobs:
#   KUBEATLAS_INSTALL_DIR=/path   install here instead of the auto-picked dir
#
# POSIX sh (works under bash, dash, and Alpine's ash). Linux + macOS; on Windows
# use the .zip from the Releases page.
set -eu

REPO="kubeatlas-org/kubeatlas"
BASE="https://github.com/${REPO}/releases/latest/download"

fail() { echo "install: $*" >&2; exit 1; }

# --- detect OS ---------------------------------------------------------------
case "$(uname -s)" in
	Linux)  OS=linux ;;
	Darwin) OS=darwin ;;
	*)      fail "unsupported OS '$(uname -s)' — Windows users: grab the .zip from the Releases page" ;;
esac

# --- detect arch -------------------------------------------------------------
case "$(uname -m)" in
	x86_64 | amd64)  ARCH=amd64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*)               fail "unsupported architecture '$(uname -m)' — builds are amd64 and arm64" ;;
esac

ASSET="kubeatlas_${OS}_${ARCH}.tar.gz"

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar  >/dev/null 2>&1 || fail "tar is required"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- download ----------------------------------------------------------------
echo "Downloading ${ASSET}…"
curl -fsSL "${BASE}/${ASSET}"        -o "${TMP}/${ASSET}"      || fail "download failed"
curl -fsSL "${BASE}/checksums.txt"   -o "${TMP}/checksums.txt" || fail "checksums download failed"

# --- verify checksum ---------------------------------------------------------
expected="$(grep "${ASSET}\$" "${TMP}/checksums.txt" | awk '{print $1}' || true)"
[ -n "$expected" ] || fail "no checksum listed for ${ASSET}"

if command -v sha256sum >/dev/null 2>&1; then
	actual="$(sha256sum "${TMP}/${ASSET}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
	actual="$(shasum -a 256 "${TMP}/${ASSET}" | awk '{print $1}')"
else
	fail "need sha256sum or shasum to verify the download"
fi

[ "$actual" = "$expected" ] || fail "checksum mismatch (expected ${expected}, got ${actual})"
echo "Checksum verified."

# --- extract -----------------------------------------------------------------
tar -xzf "${TMP}/${ASSET}" -C "$TMP" || fail "extract failed"
[ -f "${TMP}/kubeatlas" ] || fail "archive did not contain the kubeatlas binary"

# --- pick an install dir -----------------------------------------------------
# Prefer a system bin when writable (it's already on PATH); otherwise fall back
# to a user-local bin — a curl|bash pipe has no terminal to prompt sudo on.
if [ -n "${KUBEATLAS_INSTALL_DIR:-}" ]; then
	DIR="$KUBEATLAS_INSTALL_DIR"
elif [ -w /usr/local/bin ]; then
	DIR="/usr/local/bin"
else
	DIR="${HOME}/.local/bin"
fi

mkdir -p "$DIR" || fail "could not create ${DIR}"
install -m 0755 "${TMP}/kubeatlas" "${DIR}/kubeatlas" 2>/dev/null \
	|| { cp "${TMP}/kubeatlas" "${DIR}/kubeatlas" && chmod 0755 "${DIR}/kubeatlas"; } \
	|| fail "could not write to ${DIR} (set KUBEATLAS_INSTALL_DIR to a writable dir)"

echo "Installed kubeatlas to ${DIR}/kubeatlas"

# --- PATH hint ---------------------------------------------------------------
case ":${PATH}:" in
	*":${DIR}:"*)
		echo "Run it:  kubeatlas"
		;;
	*)
		echo
		echo "${DIR} is not on your PATH. Add it:"
		echo "  export PATH=\"${DIR}:\$PATH\""
		echo "or run it directly:  ${DIR}/kubeatlas"
		;;
esac
