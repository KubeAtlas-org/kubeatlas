# Branding & UI Requirements

Specs for the branding / visual-polish pass. Scope: logo & wordmark,
resource-kind icons, action/UI icons, typography & color system.

Constraints:

- No npm / no bundler on the frontend. Anything we adopt ships as static
  files loaded directly by the browser.
- The UI must support **both a dark theme and a light theme** as first-class
  peers. Every visual element specified below — logo, icons, surfaces, text,
  status colors — must have a defined appearance in both themes.
- Icons are referenced from plain HTML/CSS — no component framework.

---

## 1. Logo & Wordmark

### 1.1 Required assets

| Asset | Format | Size(s) | Path |
|------|--------|---------|------|
| Primary logo (mark only) | SVG | viewBox 64×64, 1.5px stroke at 64px | `public/img/brand/logo.svg` |
| Logo — dark theme variant | SVG | same | `public/img/brand/logo-dark.svg` |
| Logo — light theme variant | SVG | same | `public/img/brand/logo-light.svg` |
| Logo — monochrome | SVG | same, `currentColor` fills only | `public/img/brand/logo-mono.svg` |
| Wordmark (logo + "KubeAtlas") | SVG | viewBox 240×64 | `public/img/brand/wordmark.svg` |
| Favicon (modern) | SVG | 32×32 viewBox, theme-aware via `prefers-color-scheme` media query inside the SVG | `public/img/brand/favicon.svg` |
| Favicon fallback | ICO | 16, 32, 48 multi-res | `public/img/brand/favicon.ico` |
| Apple touch icon | PNG | 180×180 | `public/img/brand/apple-touch-icon.png` |
| Maskable PWA icon | PNG | 512×512, ≥20% safe-zone padding | `public/img/brand/maskable-512.png` |
| Social card | PNG | 1200×630 (OG / Twitter) | `public/img/brand/og-card.png` |

### 1.2 Design constraints

- The mark must read at **16×16** (favicon, tab) and **24×24** (topbar at
  100% zoom). Avoid >2 internal strokes; no thin (<1.25px @ 24px) strokes.
- Must work mono-tone — color is decoration, not meaning.
- Topbar render box is **20×20 px**, welcome overlay render box is **96×96
  px**. The same SVG must render cleanly at both sizes.
- The mark must work over both light and dark surfaces with no halos or
  fringing; if a single SVG can't cover both, swap variants at the
  `data-theme` boundary.
- Wordmark uses the UI body typeface (see §4).

### 1.3 HTML wiring

`<head>` must declare, in this order:

```html
<link rel="icon" type="image/svg+xml" href="public/img/brand/favicon.svg" />
<link rel="icon" type="image/x-icon"  href="public/img/brand/favicon.ico" />
<link rel="apple-touch-icon"          href="public/img/brand/apple-touch-icon.png" />
<meta property="og:image"  content="public/img/brand/og-card.png" />
<meta name="theme-color"   content="#0d1117" media="(prefers-color-scheme: dark)"  />
<meta name="theme-color"   content="#ffffff" media="(prefers-color-scheme: light)" />
```

---

## 2. Resource-Kind Icons

### 2.1 Goal

One SVG per Kubernetes kind. Status (healthy / warn / error / muted) and
theme (dark / light) are applied via CSS `currentColor` — no per-status,
per-theme file duplicates.

### 2.2 Icon-style preference (user-configurable)

Resource icons ship in **two parallel styles** the user can switch between:

1. **`lucide`** (default) — line icons from Lucide. One consistent visual
   vocabulary with the action icons (§3). Status & theme tinting via
   `currentColor`.
2. **`kubernetes`** — the official [Kubernetes icon pack](https://github.com/kubernetes/community/tree/master/icons)
   (CC BY 4.0). Filled hex badges, instantly recognizable to anyone who
   has used k9s, OpenLens, or read K8s docs. Status tinting is **not**
   applied (the K8s pack is colored per-kind by design); only theme
   adaptation (dark/light background variant of the pack).

**Storage & wiring:**

- Persisted as `localStorage.kaIconStyle` (`'lucide' | 'kubernetes'`).
  Default `'lucide'`.
- Exposed in the settings UI as a radio toggle ("Resource icon style:
  Line · Kubernetes").
- Implementation: a single `iconForKind(kind, style)` helper resolves to
  the right sprite symbol. Both sprites are loaded; the unused one is
  cached but inert. (Both together are ~30 KB gzipped — cheaper than a
  page reload on toggle.)
- Action icons (§3) are **always** Lucide regardless of this setting —
  the K8s pack has no action-icon equivalents and we want chrome
  consistency.

### 2.3 Kind → glyph mapping (both styles)

The same `kind` key resolves to one glyph per style. Disambiguation between
visually-similar kinds (Role vs. ClusterRole, PV vs. PVC) in the Lucide
column is done with hue/status color; in the Kubernetes column the pack
already differentiates them visually.

| Group | Kind | Lucide glyph | Kubernetes pack file |
|-------|------|--------------|----------------------|
| Workloads | `Pod` | `box` | `resources/labeled/pod.svg` |
| | `Deployment` | `layers` | `resources/labeled/deploy.svg` |
| | `ReplicaSet` | `boxes` | `resources/labeled/rs.svg` |
| | `StatefulSet` | `database` | `resources/labeled/sts.svg` |
| | `DaemonSet` | `server-cog` | `resources/labeled/ds.svg` |
| | `Job` | `briefcase` | `resources/labeled/job.svg` |
| | `CronJob` | `timer` | `resources/labeled/cronjob.svg` |
| | `HorizontalPodAutoscaler` | `gauge` | `resources/labeled/hpa.svg` |
| Config / Storage | `ConfigMap` | `file-cog` | `resources/labeled/cm.svg` |
| | `Secret` | `key-round` | `resources/labeled/secret.svg` |
| | `PersistentVolume` | `hard-drive` | `resources/labeled/pv.svg` |
| | `PersistentVolumeClaim` | `hard-drive-download` | `resources/labeled/pvc.svg` |
| | `StorageClass` | `database-zap` | `resources/labeled/sc.svg` |
| Network | `Service` | `network` | `resources/labeled/svc.svg` |
| | `Ingress` | `globe` | `resources/labeled/ing.svg` |
| | `NetworkPolicy` | `shield` | `resources/labeled/netpol.svg` |
| | `Endpoints` / `EndpointSlice` | `waypoints` | `resources/labeled/ep.svg` |
| Cluster | `Node` | `server` | `infrastructure_components/labeled/node.svg` |
| | `Namespace` | `folder` | `resources/labeled/ns.svg` |
| | `Event` | `bell` | (no pack glyph — fall back to Lucide `bell`) |
| RBAC (T4) | `ServiceAccount` | `user-circle` | `resources/labeled/sa.svg` |
| | `Role` | `shield-check` | `resources/labeled/role.svg` |
| | `ClusterRole` | `shield-half` | `resources/labeled/c-role.svg` |
| | `RoleBinding` | `link` | `resources/labeled/rb.svg` |
| | `ClusterRoleBinding` | `link-2` | `resources/labeled/crb.svg` |
| CRD (T4) | `CustomResourceDefinition` | `puzzle` | `resources/labeled/crd.svg` |
| Fallback | unknown kind | `circle-help` | Lucide `circle-help` |

Verify each pack-file path against the upstream tree at vendor time —
filenames in `kubernetes/community/icons` have shifted across revisions.
Pin a commit SHA (see §2.5).

### 2.4 Specs

- **Format:** SVG, viewBox **24×24**, no `width`/`height` attributes.
- **Style:** 1.5px stroke, `stroke="currentColor"`, `fill="none"` (line) **or**
  `fill="currentColor"` (solid) — pick **one** style and apply consistently
  across the whole set.
- **Stroke caps/joins:** `round` / `round`.
- **Padding:** ≥1px clear space inside the 24×24 box.
- **No embedded text, no raster, no gradients, no `<style>` blocks.**
- **Naming:** `public/img/res/<kind-kebab>.svg` — e.g.
  `persistent-volume-claim.svg`, `horizontal-pod-autoscaler.svg`.
- **Status tint** is CSS-driven and theme-aware:

  ```css
  .res-icon            { color: var(--kind-fg); }
  .res-icon.is-healthy { color: var(--status-healthy); }
  .res-icon.is-warn    { color: var(--status-warn); }
  .res-icon.is-error   { color: var(--status-error); }
  .res-icon.is-muted   { color: var(--status-muted); }
  ```

  Both themes redefine each `--status-*` token (see §4) so the same class
  produces the right contrast on either background.
- Icons must be inline `<svg>` in the DOM **or** loaded via `<img>` with a
  CSS `mask-image` strategy so `currentColor` works.

### 2.5 Sources & vendoring

Both icon styles are vendored locally — no CDN dependency at runtime.

**Lucide** ([lucide.dev](https://lucide.dev), [ISC license](https://github.com/lucide-icons/lucide/blob/main/LICENSE)):

- 24×24 viewBox, `stroke="currentColor"` native, actively maintained.
- Pin a specific release tag (e.g. `v0.460.0`) in the Makefile; never
  track `main`.
- Same set powers action icons (§3) — one consistent visual vocabulary
  across chrome.
- Bundle only the individual SVGs we use, not the full ~1,600-icon set.

**Kubernetes icon pack** ([kubernetes/community/icons](https://github.com/kubernetes/community/tree/master/icons),
[CC BY 4.0](https://github.com/kubernetes/community/blob/master/icons/LICENSE)):

- Filled hex-badge style, colored per-kind. Two sub-folders relevant to us:
  `resources/labeled/` (workloads, config, network, RBAC, CRD) and
  `infrastructure_components/labeled/` (Node). The "labeled" variants are
  the colored ones; the "unlabeled" variants are the same shapes without
  the kind abbreviation text.
- Pin a specific commit SHA (the repo has no tagged releases for icons).
- Attribution: CC BY 4.0 requires credit. Add a line in the app's About /
  Settings panel and in `public/ext/icons/k8s/README.md`:
  "Kubernetes resource icons © The Kubernetes Authors, licensed under
  CC BY 4.0."
- Bundle only the kinds listed in §2.3, not the full pack.

**Other sets considered and skipped:** Tabler / Heroicons / Phosphor /
Feather / Remix — viable line-icon alternatives but Lucide's
infrastructure-flavored vocabulary is the best fit and there's no value in
splitting between two line sets.

---

## 3. Action / UI Icons

### 3.1 Goal

Use **Lucide** (the set chosen in §2.4) for all toolbar / action
affordances. Same vendoring pipeline, same sprite, one consistent visual
vocabulary across resource icons and chrome.

### 3.2 Action → glyph mapping

| Action | Where | Lucide name |
|--------|-------|-------------|
| Search / filter | Topbar input, command palette | `search` |
| Close / dismiss | Modal, detail pane, logs/exec view | `x` |
| Expand pane | Detail pane | `maximize-2` |
| Collapse pane | Detail pane | `minimize-2` |
| Copy to clipboard | YAML view, detail rows | `copy` |
| Edit YAML | YAML view, detail pane | `pencil` |
| Delete | Detail pane (hold) | `trash-2` |
| Restart workload | Action menu | `rotate-cw` |
| Scale | Action menu | `move-vertical` |
| Logs | Pod row, action menu | `file-text` |
| Exec / shell | Pod row, action menu | `terminal` |
| Refresh | Logs view header | `refresh-cw` |
| Graph view toggle | Topbar | `share-2` |
| Table view toggle | Topbar | `table` |
| Drill into | Drillable row hover | `chevron-right` |
| Breadcrumb back | Breadcrumb chevrons | `chevron-left` |
| Sort asc / desc | Table column header | `chevron-up` / `chevron-down` |
| Time / age | Status column | `clock` |
| Events | Detail pane events tab | `bell` |
| Info / tooltip | Inline help | `info` |
| Context switch | Status bar | `globe` |
| Namespace switch | Status bar | `layers` |
| Theme toggle | Status bar / settings | `sun` (in dark) / `moon` (in light) |
| External link / GitHub | Footer | `github` |
| Status dot (healthy/warn/error) | Row prefix, graph legend | filled circle (pure CSS) |
| More / overflow | Action menu trigger | `more-horizontal` |
| Code view | YAML view header | `code` |
| Locate / center | Graph toolbar | `crosshair` |
| Expand fullscreen | Logs view | `maximize` |
| History / replay | Logs view | `history` |

### 3.3 Specs

- Size tokens (CSS custom props):
  - `--icon-xs: 12px` — inline with body text, breadcrumb chevrons.
  - `--icon-sm: 14px` — table cell affordances.
  - `--icon-md: 16px` — topbar / status bar default.
  - `--icon-lg: 20px` — action menu, detail pane buttons.
  - `--icon-xl: 24px` — empty-state graphics, welcome overlay.
- Stroke weight constant at 1.5px regardless of rendered size.
- Icon color is always `currentColor`; the parent text color decides the hue
  per theme.
- Hover: parent button gets `background: var(--hover-bg)`; icon color
  follows `currentColor`. No icon-only color changes.
- Disabled: `opacity: 0.4`, no color shift.
- Active toggle (e.g. graph vs table mode): icon color `var(--accent)`, no
  background fill.
- Buttons wrapping an icon must keep a min hit target of **28×28 px** even
  when the visible icon is 16 px.

### 3.4 Delivery & vendoring

We ship **two sprites**: one Lucide (action icons + lucide-style resource
icons), one Kubernetes pack (kubernetes-style resource icons). The active
resource sprite is selected at runtime by `localStorage.kaIconStyle`
(§2.2). The Lucide sprite is always loaded because action icons depend on
it.

**Lucide sprite — `public/ext/icons/sprite-lucide.svg`:**

- **Source list:** `public/ext/icons/lucide.txt` — one Lucide name per
  line (resource glyphs from §2.3 Lucide column + every action glyph from
  §3.2). Single source of truth.
- **Format:** each name wrapped as `<symbol id="i-<name>" viewBox="0 0 24 24">…</symbol>`,
  concatenated into a single `<svg style="display:none">…</svg>` written
  to `sprite-lucide.svg`. Upstream icons fetched from
  `https://raw.githubusercontent.com/lucide-icons/lucide/<version>/icons/<name>.svg`.

**Kubernetes sprite — `public/ext/icons/sprite-k8s.svg`:**

- **Source list:** `public/ext/icons/k8s.txt` — one upstream path per line
  (the right-hand column of §2.3, restricted to kinds the pack covers).
- **Format:** each path wrapped as `<symbol id="k-<kind-kebab>" viewBox="…">…</symbol>`
  (preserving each source SVG's original viewBox — pack icons are not all
  24×24), concatenated into `sprite-k8s.svg`. Upstream icons fetched from
  `https://raw.githubusercontent.com/kubernetes/community/<sha>/icons/<path>`.

The build pipeline that generated the committed sprites (a small shell
script + makefile targets) was omitted from this demo-day snapshot. The
sprites are committed; regenerate only when source lists or pinned
upstream versions change.

**HTML reference:**

```html
<!-- action icon (always Lucide) -->
<svg class="icon"><use href="/ext/icons/sprite-lucide.svg#i-search" /></svg>

<!-- resource icon (sprite chosen at runtime by iconForKind()) -->
<svg class="res-icon"><use href="/ext/icons/sprite-lucide.svg#i-box" /></svg>
<!-- …or, when kaIconStyle === 'kubernetes': -->
<svg class="res-icon"><use href="/ext/icons/sprite-k8s.svg#k-pod" /></svg>
```

`currentColor` works through `<use>` for the Lucide sprite (CSS
`color:` recolors per theme/status). The K8s sprite is colored per-kind by
design — CSS does **not** override its fills.

**Documentation:** `public/ext/icons/README.md` lists the pinned versions,
the `*.txt` → sprite build flow, the kind → glyph mapping from §2.3, and
the CC BY 4.0 attribution required by the K8s pack.

---

## 4. Typography & Color System

### 4.1 Typography

| Token | Value | Use |
|-------|-------|-----|
| `--font-sans` | `'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` | All UI text |
| `--font-mono` | `'JetBrains Mono', 'Fira Code', ui-monospace, 'SF Mono', Menlo, Consolas, monospace` | YAML, logs, exec, code |
| `--font-display` | same as `--font-sans`, weight 600 | Wordmark, section headers |

- Self-host Inter and JetBrains Mono under `public/ext/fonts/` (woff2 only,
  Latin subset). No third-party font CDNs.
- `font-display: swap` so the UI never blocks on font load.
- Font features: `font-feature-settings: 'tnum' 1, 'cv11' 1;` on tables and
  status columns (tabular numbers).

### 4.2 Type scale (rem, base 16px)

| Token | Size | Line height | Use |
|-------|------|-------------|-----|
| `--text-xs` | 0.75 (12px) | 1.4 | Status bar, hint chips |
| `--text-sm` | 0.8125 (13px) | 1.45 | Tables, detail pane labels |
| `--text-base` | 0.875 (14px) | 1.5 | Body, detail pane values |
| `--text-md` | 1.0 (16px) | 1.4 | Section headers |
| `--text-lg` | 1.125 (18px) | 1.35 | Modal titles |
| `--text-xl` | 1.5 (24px) | 1.2 | Welcome overlay wordmark |

Weights: 400 (body), 500 (table row emphasis), 600 (headers / wordmark).
Never use 700+ in UI chrome.

### 4.3 Color system

Every visual token is defined **twice** — once under `:root` (dark, default)
and once under `[data-theme="light"]`. No component CSS may reference a raw
hex; everything goes through a token.

#### 4.3.1 Theme switching

- The active theme is a class/attribute on `<html>`: `data-theme="dark"`
  (default) or `data-theme="light"`.
- Initial value: read `localStorage.kaTheme`; fall back to
  `prefers-color-scheme`; fall back to `dark`.
- The toggle is keyboard-accessible and lives in the status bar (icon: §3.2
  theme toggle row).
- Theme changes must not cause a JS flicker on load — set the attribute in a
  small inline `<head>` script before stylesheets resolve.
- Persisted via `localStorage.kaTheme` (`'dark' | 'light' | 'auto'`).

Token names below are the ones actually declared in `public/css/main.css`.
The tables list the foundational tokens; long-tail variants
(`--bg-row-hover`, `--bg-elevated-hover`, `--text-statuslabel`, …) live in
the stylesheet and follow the same role/value conventions.

#### 4.3.2 Accent

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `--accent` | `#4d82ff` | `#2962FF` | Primary accent (links, selection text, focus) |
| `--accent-soft` | `#7aa0ff` | `#5b8dff` | Lighter accent (hover lift on accent affordances) |
| `--accent-softer` | `#a8c2ff` | `#8fb0ff` | Subtle accent overlays |
| `--bg-accent` | `#1e3a5f` | `#dbeafe` | Accent-tinted background (selected row) |
| `--bg-accent-deep` | `#1d3557` | `#bfd7f3` | Deeper accent fill (focused selection) |

Brand color is **`#2962FF`** (logo, favicon, OG card). The light theme uses
it directly for `--accent` — it clears WCAG AA (~4.9:1) on white. The dark
theme uses a lighter sibling of the same hue (`#4d82ff`, ~5.4:1 on the dark
panel) since raw `#2962FF` only reaches ~3.8:1 there. Same hue, contrast-
tuned per surface.

#### 4.3.3 Surface

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `--bg-app` | `#0f1117` | `#ffffff` | App background |
| `--bg-panel` | `#0d1117` | `#f7f8fa` | Topbar, sidebar, status bar |
| `--bg-detail` | `#090d14` | `#fbfcfd` | Bottom detail pane |
| `--bg-logs` / `--bg-cmd` / `--bg-yaml-editor` / `--bg-exec` | `#080c10` / `#0d0f17` / `#0d0f14` / `#0a0e14` | `#f7f8fa` / `#f7f8fa` / `#ffffff` / `#ffffff` | Sunken wells (logs, palette, YAML, terminal) |
| `--bg-table-head` | `#111318` | `#eef0f4` | Sticky table header |
| `--bg-elevated` | `#1a1d23` | `#e6e9ef` | Buttons, kbd chips, hover lift |
| `--bg-selected` | `#1c2a45` | `#dbeafe` | Selected table row |
| `--border` | `#2e3140` | `#d0d7e2` | Default border |
| `--border-strong` | `#374151` | `#a7b1c2` | Modal / panel border |
| `--border-stronger` | `#4b5563` | `#8c95a4` | Heightened separators |

#### 4.3.4 Text

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `--text-primary` | `#e2e8f0` | `#1f2328` | Body, primary copy |
| `--text-primary-2` | `#f1f5f9` | `#0d1117` | Highest-contrast emphasis |
| `--text-secondary` | `#c8d3e0` | `#374151` | Detail-pane values, code |
| `--text-tertiary` | `#9ca3af` | `#57606a` | Captions, hint text |
| `--text-muted` | `#6b7280` | `#6b7280` | Placeholders, disabled |
| `--text-table-head` | `#8899aa` | `#6b7280` | Table column labels |

#### 4.3.5 Status

Status hue is shared across themes but lightness differs so contrast stays
≥4.5:1 on each background. Token meaning must match `status.js#statusClass`
output; new statuses get added here and there together, not just in CSS.

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `--success`, `--success-text` | `#22c55e`, `#4ade80` | `#15803d`, `#15803d` | Pod Ready, Deployment available |
| `--success-bg`, `--success-border` | `#14532d`, `#166534` | `#dcfce7`, `#86efac` | Status-pill fill / border |
| `--warn`, `--warn-text` | `#eab308`, `#facc15` | `#a16207`, `#a16207` | Pending, Progressing |
| `--warn-accent` | `#f59e0b` | `#b45309` | Heightened warnings |
| `--warn-bg` | `#854d0e` | `#fef9c3` | Warn pill fill |
| `--danger`, `--danger-text` | `#ef4444`, `#f87171` | `#b91c1c`, `#b91c1c` | CrashLoop, Failed, delete |
| `--danger-bg`, `--danger-border` | `#2d1010`, `#7f1d1d` | `#fee2e2`, `#fca5a5` | Danger pill fill / border |

`--text-muted` (gray) covers Unknown / Terminating in both themes — reuse
the neutral text scale rather than introducing a separate `--status-muted`
so an "unknown" pod doesn't visually compete with real warnings.

#### 4.3.6 Graph edges

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `--edge-owner`   | `#9aa0a6` | `#57606a` | Ownership |
| `--edge-network` | `#4a9eff` | `#1f6feb` | Service→Pod |
| `--edge-mount`   | `#3ecf8e` | `#15803d` | PVC/ConfigMap/Secret→Pod |
| `--edge-env`     | `#f5a623` | `#a16207` | env-ref → ConfigMap/Secret |

The canvas renderer must read these tokens via
`getComputedStyle(document.documentElement).getPropertyValue('--edge-…')`
at theme-change time, not hard-code hex values.

### 4.4 Contrast & a11y

- All `--fg*` tokens against their default background must hit WCAG AA
  (4.5:1 for body, 3:1 for ≥18px) **in both themes**. Verify before merging.
- Status colors used as the **only** signal (e.g. graph node fill) must be
  paired with a glyph or text label — colorblind users can't read healthy
  vs. error from hue alone.
- Focus ring: `outline: 2px solid var(--accent); outline-offset: 2px;` on all
  keyboard-focusable controls.
- `prefers-reduced-motion: reduce` disables non-essential transitions
  (theme cross-fade, pane slide-in).

---

## 5. Deliverables Checklist

- [ ] `public/img/brand/` populated with logo / favicon / OG card variants,
      with dark- and light-theme variants where needed.
- [ ] `<head>` of every HTML entrypoint declares favicon, apple-touch-icon,
      OG image, and both `theme-color` media queries.
- [ ] Status & theme tinting for **Lucide-style** resource icons are
      CSS-driven via `currentColor`; no per-status or per-theme duplicate
      SVGs. K8s-style icons keep their pack-defined colors.
- [ ] `public/ext/icons/sprite-lucide.svg` and `sprite-k8s.svg` are both
      committed; resource icons reference whichever the user picked via
      `iconForKind()`.
- [ ] `public/ext/icons/lucide.txt` and `k8s.txt` list every glyph we
      vendor from each upstream.
- [ ] Settings UI exposes the "Resource icon style" toggle; selection is
      persisted in `localStorage.kaIconStyle` (`'lucide'` default).
- [ ] CC BY 4.0 attribution for the Kubernetes icon pack appears in the
      About / Settings panel.
- [ ] `public/ext/icons/README.md` documents both pipelines, the kind →
      glyph mapping for both styles, and the attribution line.
- [ ] `public/ext/fonts/` contains Inter + JetBrains Mono woff2; `@font-face`
      declared in `public/css/main.css`.
- [ ] Every CSS color is a token; no bare hex literals outside the `:root`
      and `[data-theme="light"]` blocks.
- [ ] Theme toggle wired up, persisted in `localStorage.kaTheme`, no
      load-time flicker, honors `prefers-color-scheme` in `auto` mode.
- [ ] Graph canvas reads color tokens from CSS at theme-switch time.

## 6. Out of Scope

- Animations / motion language (separate doc when needed).
- Empty-state illustrations beyond the welcome overlay.
- Print / export styling for YAML.
- Internationalization of brand text.
- Marketing site / landing page.
