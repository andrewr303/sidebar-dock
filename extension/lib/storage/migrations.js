/*
 * Library schema versions and migrations.
 *
 * chrome.storage.local['still.library.v1'].schemaVersion says which shape the library was written in. This build reads
 * and writes LIBRARY_SCHEMA_VERSION. A library saved by a NEWER build is never written by this one (fields and rules it
 * does not know could be lost), so every store operation refuses with NewerLibraryError and nothing changes. An OLDER
 * library is upgraded in order through LIBRARY_MIGRATIONS, after the store's 'before-migration' snapshot hook.
 *
 * A migration is { version, migrate(state) -> state }: it upgrades a library from `version - 1` to `version`. It runs on
 * raw stored data (before normalisation), must be pure and synchronous, must never drop records or unknown fields, and
 * should bump `updatedAt` on every record it changes so a later sync engine sees the change. Never edit a shipped
 * migration; add the next version instead.
 */
export const LIBRARY_SCHEMA_VERSION = 1;

// Ordered by version. Empty while the stored shape is still version 1.
export const LIBRARY_MIGRATIONS = Object.freeze([]);

export const NEWER_LIBRARY_MESSAGE = 'Your library was saved by a newer version of Still. Update Still to keep editing; nothing was changed.';

export class NewerLibraryError extends Error {
  constructor(found, supported = LIBRARY_SCHEMA_VERSION) {
    super(NEWER_LIBRARY_MESSAGE);
    this.name = 'NewerLibraryError';
    this.code = 'still/newer-library';
    this.found = found;
    this.supported = supported;
  }
}

/** The schema version of stored or imported library data. A missing version is the original version 1. */
export function libraryVersion(data) {
  const raw = data?.schemaVersion;
  if (raw === undefined || raw === null || raw === '') return 1;
  const version = Number(raw);
  // A version this build cannot read as a whole number is treated as unknown (newer): never written over.
  return Number.isInteger(version) && version >= 1 ? version : Infinity;
}

/** Throws NewerLibraryError when the data needs a newer build. Returns the data's version otherwise. */
export function assertLibraryVersion(data, supported = LIBRARY_SCHEMA_VERSION) {
  const version = libraryVersion(data);
  if (version > supported) throw new NewerLibraryError(data?.schemaVersion, supported);
  return version;
}

/** True when the data is older than `target` and must be migrated before use. */
export const needsMigration = (data, target = LIBRARY_SCHEMA_VERSION) => libraryVersion(data) < target;

/**
 * Upgrades library data to `target` through the ordered registry. Returns { data, from, to, migrated }. The input object
 * is not modified (each step works on a structured clone). Throws when a step is missing or a migration fails, so a
 * half-migrated library is never written.
 */
export function migrateLibrary(data, { migrations = LIBRARY_MIGRATIONS, target = LIBRARY_SCHEMA_VERSION } = {}) {
  const from = assertLibraryVersion(data, target);
  let current = data, version = from;
  if (version === target) return { data: current, from, to: target, migrated: false };
  const steps = [...migrations].sort((a, b) => a.version - b.version);
  while (version < target) {
    const step = steps.find(entry => entry.version === version + 1);
    if (!step || typeof step.migrate !== 'function') throw new Error(`Still cannot upgrade this library from schema ${version}; nothing was changed.`);
    const next = step.migrate(structuredClone(current));
    if (!next || typeof next !== 'object' || !Array.isArray(next.items) || !Array.isArray(next.collections)) {
      throw new Error(`Library migration to schema ${step.version} returned an invalid library; nothing was changed.`);
    }
    next.schemaVersion = step.version;
    current = next; version = step.version;
  }
  return { data: current, from, to: target, migrated: true };
}
