#!/usr/bin/env bash
# =============================================================================
# Regenerate the raster brand assets from their canonical SVG sources, so the
# PNGs/ICO stay in lockstep with the vector originals. The SVGs carry zero
# outer margin (the frontend owns spacing); the rasters bake in the margins a
# fixed-size icon needs.
#
# Outputs (public/img/brand/):
#   apple-touch-icon.png  180x180, ~12% margin, opaque brand background
#   maskable-512.png      512x512, ~20% safe-zone, opaque brand background
#   og-card.png           1200x630 social card (real Inter via fontconfig)
#   favicon.ico           16/32/48 multi-resolution
#
# Requires: rsvg-convert (librsvg), ImageMagick (magick or convert), python3 + fontTools.
# SVG <text> renders in an isolated context that ignores the page @font-face,
# so we expose the bundled Inter woff2 as TTF through a throwaway fontconfig
# env — otherwise og-card's wordmark would fall back to a system font.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BRAND="$ROOT/public/img/brand"
FONTS="$ROOT/public/ext/fonts"
BG="#0d1117"   # --bg-panel / theme-color (dark); matches the icons' surface

for bin in rsvg-convert python3; do
  command -v "$bin" >/dev/null || { echo "💥 missing required tool: $bin" >&2; exit 1; }
done
# ImageMagick is `magick` in v7 (macOS/brew) and `convert` in v6 (Debian/devcontainer).
MAGICK="$(command -v magick || command -v convert || true)"
[ -n "$MAGICK" ] || { echo "💥 missing required tool: ImageMagick (magick or convert)" >&2; exit 1; }

# --- Throwaway fontconfig env exposing Inter (woff2 -> ttf) for SVG text ------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FONTDIR="$TMP/fonts"; mkdir -p "$FONTDIR" "$TMP/cache"
for w in 400 500 600 800; do
  python3 - "$FONTS/inter-$w.woff2" "$FONTDIR/inter-$w.ttf" <<'PY'
import sys
from fontTools.ttLib import TTFont
f = TTFont(sys.argv[1]); f.flavor = None; f.save(sys.argv[2])
PY
done
cat > "$TMP/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>$FONTDIR</dir>
  <cachedir>$TMP/cache</cachedir>
</fontconfig>
EOF
export FONTCONFIG_FILE="$TMP/fonts.conf"

# --- Icon PNGs: dark-surface mark on the brand background, centred -----------
# librsvg won't rasterize an external SVG referenced via <image>, so render the
# mark to a transparent PNG first, then composite it onto the background.
# $1 size  $2 content fraction (mark box as a share of the canvas)  $3 output
icon() {
  local size="$1" frac="$2" out="$3"
  read -r ch cw x y < <(python3 -c "
s=$size; f=$frac
ch=round(s*f); cw=round(ch*242/272)          # preserve the mark's 242x272 aspect
print(ch, cw, round((s-cw)/2), round((s-ch)/2))")
  rsvg-convert -w "$cw" -h "$ch" "$BRAND/logo-dark.svg" -o "$TMP/mark.png"
  "$MAGICK" -size "${size}x${size}" "xc:$BG" \
    "$TMP/mark.png" -geometry "+${x}+${y}" -composite \
    -strip -define png:exclude-chunks=date,time "$out"
  echo "  ✓ ${out##*/}"
}

echo "🎨 regenerating brand rasters…"
icon 180 0.76 "$BRAND/apple-touch-icon.png"   # ~12% margin each side
icon 512 0.60 "$BRAND/maskable-512.png"        # ~20% safe-zone each side

# --- Social card (Inter 800 + 600 text) --------------------------------------
rsvg-convert -w 1200 -h 630 "$BRAND/og-card.svg" -o "$BRAND/og-card.png"
echo "  ✓ og-card.png"

# --- Favicon: 16/32/48 multi-resolution .ico ---------------------------------
for s in 16 32 48; do
  rsvg-convert -w "$s" -h "$s" "$BRAND/favicon.svg" -o "$TMP/fav-$s.png"
done
"$MAGICK" "$TMP/fav-16.png" "$TMP/fav-32.png" "$TMP/fav-48.png" -strip "$BRAND/favicon.ico"
echo "  ✓ favicon.ico"

echo "✅ brand rasters regenerated"
