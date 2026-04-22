import { ulid, factory } from "ulid";

/**
 * Injectable ULID factory for deterministic tests.
 * In production, uses real monotonic ULIDs.
 */
let currentFactory: () => string = ulid;

export function newId(): string {
  return currentFactory();
}

export function setIdFactory(fn: () => string): void {
  currentFactory = fn;
}

export function resetIdFactory(): void {
  currentFactory = ulid;
}

/** Create a seeded factory for tests. */
export function seededIdFactory(seed: number): () => string {
  return factory(() => seed);
}
