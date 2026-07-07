// Entity-version bookkeeping for optimistic concurrency. Mutation call sites
// resolve `expectedVersion` through versionOf()/settingsVersion() AT SEND
// TIME (App.tsx serializes mutations, so the previous save has responded by
// then) — otherwise a second quick edit to the same entity would carry the
// version from before the first save and self-conflict.
//
// Two sources, newest wins:
// - `latest`: the last fetched AppState (what this client has SEEN — the
//   basis for detecting other users' unseen changes),
// - `overlay`: versions learned from this client's own mutation responses
//   (api.ts calls noteVersion), so back-to-back edits don't have to wait for
//   a full refetch.
import type { AppState } from '../../shared/types.js';

type VersionedKind = 'users' | 'roles' | 'shiftTypes' | 'holidays' | 'awayTime' | 'settings';

let latest: AppState | null = null;
const overlay = new Map<string, number>();

function baseVersion(kind: VersionedKind, id: string): number | undefined {
  if (!latest) return undefined;
  if (kind === 'settings') return latest.settings?.version;
  const list = latest[kind] as { id: string; version?: number }[] | undefined;
  return list?.find((e) => e.id === id)?.version;
}

export function setLatestState(state: AppState): void {
  latest = state;
  // Drop overlay entries the fetched state has caught up with.
  for (const [key, v] of overlay) {
    const sep = key.indexOf(':');
    const base = baseVersion(key.slice(0, sep) as VersionedKind, key.slice(sep + 1));
    if (base !== undefined && base >= v) overlay.delete(key);
  }
}

// Record the version a mutation response reported for an entity.
export function noteVersion(kind: VersionedKind, id: string, version: unknown): void {
  if (typeof version === 'number') overlay.set(`${kind}:${id}`, version);
}

export function versionOf(kind: Exclude<VersionedKind, 'settings'>, id: string): number | undefined {
  const base = baseVersion(kind, id);
  const noted = overlay.get(`${kind}:${id}`);
  if (base === undefined) return noted;
  return noted === undefined ? base : Math.max(base, noted);
}

export function settingsVersion(): number | undefined {
  const base = baseVersion('settings', 'settings');
  const noted = overlay.get('settings:settings');
  if (base === undefined) return noted;
  return noted === undefined ? base : Math.max(base, noted);
}
