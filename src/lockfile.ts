import { basename, dirname, join } from "@std/path";
import { LOCKFILE_SCHEMA_VERSION } from "./constants.ts";
import { LockFileValidationError, SourceRefIoError } from "./errors.ts";
import { parseRepositoryKey } from "./layout.ts";
import type { CheckoutMode, GitRef } from "./types.ts";

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface LockEntry {
  readonly url: string;
  readonly mode: CheckoutMode;
  readonly requested: GitRef;
  readonly resolvedCommit: string;
}

export interface SourceRefLockFile {
  readonly schemaVersion: 1;
  readonly repositories: Record<string, LockEntry>;
}

export function emptyLockFile(): SourceRefLockFile {
  return { schemaVersion: LOCKFILE_SCHEMA_VERSION, repositories: {} };
}

export async function readLockFile(path: string): Promise<SourceRefLockFile> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return emptyLockFile();
    throw new SourceRefIoError("read lock file", path, { cause });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new LockFileValidationError(path, "file is not valid JSON", { cause });
  }
  return validateLockFile(value, path);
}

export function validateLockFile(value: unknown, path = "source-ref.lock.json"): SourceRefLockFile {
  if (!isRecord(value)) throw invalid(path, "root must be an object");
  assertKeys(value, ["schemaVersion", "repositories"], path, "root");
  if (value.schemaVersion !== LOCKFILE_SCHEMA_VERSION) {
    throw invalid(path, `unsupported schemaVersion '${String(value.schemaVersion)}'`);
  }
  if (!isRecord(value.repositories)) throw invalid(path, "repositories must be an object");

  const repositories: Record<string, LockEntry> = {};
  for (const [key, entry] of Object.entries(value.repositories)) {
    try {
      parseRepositoryKey(key);
    } catch (cause) {
      throw invalid(path, `repository key '${key}' is invalid`, cause);
    }
    repositories[key] = validateEntry(entry, path, key);
  }
  return { schemaVersion: LOCKFILE_SCHEMA_VERSION, repositories };
}

export async function writeLockFile(path: string, lock: SourceRefLockFile): Promise<void> {
  const validated = validateLockFile(lock, path);
  await atomicWriteJson(path, validated);
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  try {
    await Deno.mkdir(parent, { recursive: true });
  } catch (cause) {
    throw new SourceRefIoError("create JSON parent directory", parent, { cause });
  }

  const temporary = join(parent, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o644 });
    let offset = 0;
    while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
    await file.sync();
    file.close();
    file = undefined;
    await Deno.rename(temporary, path);
  } catch (cause) {
    try {
      file?.close();
    } catch {
      // Preserve the original I/O failure.
    }
    try {
      await Deno.remove(temporary);
    } catch (cleanupCause) {
      if (!(cleanupCause instanceof Deno.errors.NotFound)) {
        // Preserve the original I/O failure.
      }
    }
    throw new SourceRefIoError("atomically write JSON file", path, { cause });
  }
}

function validateEntry(value: unknown, path: string, key: string): LockEntry {
  if (!isRecord(value)) throw invalid(path, `entry '${key}' must be an object`);
  assertKeys(value, ["url", "mode", "requested", "resolvedCommit"], path, `entry '${key}'`);
  if (typeof value.url !== "string" || !value.url || value.url.length > 8192) {
    throw invalid(path, `entry '${key}'.url must be a non-empty string`);
  }
  if (value.mode !== "pinned" && value.mode !== "branch") {
    throw invalid(path, `entry '${key}'.mode must be 'pinned' or 'branch'`);
  }
  const requested = validateRef(value.requested, path, key);
  if (value.mode === "branch" && requested.kind !== "branch") {
    throw invalid(path, `entry '${key}' in branch mode must request a branch`);
  }
  if (typeof value.resolvedCommit !== "string" || !COMMIT_PATTERN.test(value.resolvedCommit)) {
    throw invalid(
      path,
      `entry '${key}'.resolvedCommit must be a lowercase 40- or 64-character object ID`,
    );
  }
  return { url: value.url, mode: value.mode, requested, resolvedCommit: value.resolvedCommit };
}

function validateRef(value: unknown, path: string, key: string): GitRef {
  if (!isRecord(value)) throw invalid(path, `entry '${key}'.requested must be an object`);
  assertKeys(value, ["kind", "value"], path, `entry '${key}'.requested`);
  if (value.kind !== "tag" && value.kind !== "branch" && value.kind !== "commit") {
    throw invalid(path, `entry '${key}'.requested.kind is invalid`);
  }
  if (typeof value.value !== "string" || !value.value || value.value.length > 1024) {
    throw invalid(path, `entry '${key}'.requested.value must be a non-empty string`);
  }
  return { kind: value.kind, value: value.value } as GitRef;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  location: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw invalid(path, `${location} has unknown field '${unknown[0]}'`);
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length) throw invalid(path, `${location} is missing field '${missing[0]}'`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, reason: string, cause?: unknown): LockFileValidationError {
  return new LockFileValidationError(
    path,
    reason,
    cause === undefined ? undefined : { cause },
  );
}
