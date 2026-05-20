// ────────────────────────────────────────────────────────────────────────────
//  Icon resolution
//
//  Single source of truth for `<svg><use href=...>` references. Components
//  call iconHref(kind|action, style) and never name a Lucide / K8s glyph
//  directly — that keeps the kind→glyph table here, swappable in one place.
//
//  Resource icon style is read from localStorage.kaIconStyle:
//      'lucide'      — line icons from public/ext/icons/sprite-lucide.svg
//      'kubernetes'  — official pack from public/ext/icons/sprite-k8s.svg
//  Default is 'lucide'. The user-facing toggle is intentionally not wired
//  yet — see docs/branding_requirements.md §2.2.
// ────────────────────────────────────────────────────────────────────────────

// Cache buster — bump in lockstep with the makefile's icon-sprite targets so
// that committed sprite changes propagate to clients without a hard reload.
// Pairs with the `?v=` strings on the main CSS / JS in index.html.
const SPRITE_VERSION = '76'
const LUCIDE_SPRITE = `/public/ext/icons/sprite-lucide.svg?v=${SPRITE_VERSION}`
const K8S_SPRITE = `/public/ext/icons/sprite-k8s.svg?v=${SPRITE_VERSION}`

/** kind (PascalCase) → Lucide glyph name. See docs/branding_requirements.md §2.3. */
const KIND_TO_LUCIDE = {
  Pod: 'box',
  Deployment: 'layers',
  ReplicaSet: 'boxes',
  StatefulSet: 'database',
  DaemonSet: 'server-cog',
  Job: 'briefcase',
  CronJob: 'timer',
  HorizontalPodAutoscaler: 'gauge',
  ConfigMap: 'file-cog',
  Secret: 'key-round',
  PersistentVolume: 'hard-drive',
  PersistentVolumeClaim: 'hard-drive-download',
  StorageClass: 'disc',
  Service: 'network',
  Ingress: 'globe',
  NetworkPolicy: 'shield',
  Endpoints: 'cable',
  EndpointSlice: 'cable',
  Node: 'server',
  Namespace: 'folder',
  Event: 'bell',
  ServiceAccount: 'user-circle',
  Role: 'shield-check',
  ClusterRole: 'shield-alert',
  RoleBinding: 'link',
  ClusterRoleBinding: 'link-2',
  CustomResourceDefinition: 'puzzle',
}

/** kind (PascalCase) → K8s sprite id (the kind-kebab from k8s.txt). */
export const KIND_TO_K8S = {
  Pod: 'pod',
  Deployment: 'deployment',
  ReplicaSet: 'replicaset',
  StatefulSet: 'statefulset',
  DaemonSet: 'daemonset',
  Job: 'job',
  CronJob: 'cronjob',
  HorizontalPodAutoscaler: 'horizontalpodautoscaler',
  ConfigMap: 'configmap',
  Secret: 'secret',
  PersistentVolume: 'persistentvolume',
  PersistentVolumeClaim: 'persistentvolumeclaim',
  StorageClass: 'storageclass',
  Service: 'service',
  Ingress: 'ingress',
  NetworkPolicy: 'networkpolicy',
  Endpoints: 'endpoints',
  EndpointSlice: 'endpoints',
  Node: 'node',
  Namespace: 'namespace',
  ServiceAccount: 'serviceaccount',
  Role: 'role',
  ClusterRole: 'clusterrole',
  RoleBinding: 'rolebinding',
  ClusterRoleBinding: 'clusterrolebinding',
  CustomResourceDefinition: 'customresourcedefinition',
  // Event has no K8s pack glyph — iconForKind() falls back to Lucide.
}

const FALLBACK_LUCIDE = 'help-circle'

/** Current resource icon style. Honored by iconForKind(). */
export const getIconStyle = () => {
  try {
    const v = localStorage.getItem('kaIconStyle')
    return v === 'kubernetes' ? 'kubernetes' : 'lucide'
  } catch (_) {
    return 'lucide'
  }
}

/**
 * Resolve an `<svg><use href=...>` URL for a Kubernetes resource kind.
 * Honors the active icon style; falls back to Lucide for kinds the K8s
 * pack doesn't cover (e.g. Event) and for unknown kinds.
 *
 * @param {string} kind  PascalCase Kubernetes kind (Pod, Deployment, ...)
 * @param {'lucide'|'kubernetes'} [style]  Override of getIconStyle()
 * @returns {string} URL fragment for <use href="...">
 */
export const iconForKind = (kind, style) => {
  const s = style || getIconStyle()
  if (s === 'kubernetes' && KIND_TO_K8S[kind]) {
    return `${K8S_SPRITE}#k-${KIND_TO_K8S[kind]}`
  }
  const name = KIND_TO_LUCIDE[kind] || FALLBACK_LUCIDE
  return `${LUCIDE_SPRITE}#i-${name}`
}

/**
 * Resolve an `<use href=...>` URL for an action / chrome icon. Always
 * Lucide — the K8s pack has no action equivalents and we want chrome
 * consistency across the app.
 *
 * @param {string} name  Lucide glyph name (e.g. 'search', 'x', 'trash-2')
 */
export const iconAction = (name) => `${LUCIDE_SPRITE}#i-${name}`
