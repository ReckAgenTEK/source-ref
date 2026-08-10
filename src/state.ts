import { STATE_SCHEMA_VERSION } from "./constants.ts";
import { SourceRefIoError, StateFileValidationError } from "./errors.ts";
import { parseRepositoryKey } from "./layout.ts";
import { atomicWriteJson } from "./lockfile.ts";

export interface StateEntry {
  readonly url: string;
  readonly identity: string;
  readonly repositoryHome: string;
  readonly checkoutPath: string;
  readonly lastFetchAt?: string;
  readonly lastOperationAt: string;
}

export interface SourceRefStateFile {
  readonly schemaVersion: 1;
  readonly repositories: Record<string, StateEntry>;
}

export function emptyStateFile(): SourceRefStateFile {
  return { schemaVersion: STATE_SCHEMA_VERSION, repositories: {} };
}

export async function readStateFile(path: string): Promise<SourceRefStateFile> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return emptyStateFile();
    throw new SourceRefIoError("read state file", path, { cause });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new StateFileValidationError(path, "file is not valid JSON", { cause });
  }
  return validateStateFile(value, path);
}

export function validateStateFile(value: unknown, path = "state.json"): SourceRefStateFile {
  if (!isRecord(value)) throw invalid(path, "root must be an object");
  assertKeys(value, ["schemaVersion", "repositories"], path, "root");
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw invalid(path, `unsupported schemaVersion '${String(value.schemaVersion)}'`);
  }
  if (!isRecord(value.repositories)) throw invalid(path, "repositories must be an object");

  const repositories: Record<string, StateEntry> = {};
  for (const [key, raw] of Object.entries(value.repositories)) {
    try {
      parseRepositoryKey(key);
    } catch (cause) {
      throw invalid(path, `repository key '${key}' is invalid`, cause);
    }
    if (!isRecord(raw)) throw invalid(path, `entry '${key}' must be an object`);
    const allowed = [
      "url",
      "identity",
      "repositoryHome",
      "checkoutPath",
      "lastFetchAt",
      "lastOperationAt",
    ];
    assertKeys(raw, allowed, path, `entry '${key}'`, ["lastFetchAt"]);
    for (
      const field of [
        "url",
        "identity",
        "repositoryHome",
        "checkoutPath",
        "lastOperationAt",
      ] as const
    ) {
      if (typeof raw[field] !== "string" || !raw[field]) {
        throw invalid(path, `entry '${key}'.${field} must be a non-empty string`);
      }
    }
    if (!isTimestamp(raw.lastOperationAt)) {
      throw invalid(path, `entry '${key}'.lastOperationAt must be an ISO timestamp`);
    }
    if (raw.lastFetchAt !== undefined && !isTimestamp(raw.lastFetchAt)) {
      throw invalid(path, `entry '${key}'.lastFetchAt must be an ISO timestamp`);
    }
    repositories[key] = {
      url: raw.url as string,
      identity: raw.identity as string,
      repositoryHome: raw.repositoryHome as string,
      checkoutPath: raw.checkoutPath as string,
      lastOperationAt: raw.lastOperationAt as string,
      ...(raw.lastFetchAt === undefined ? {} : { lastFetchAt: raw.lastFetchAt as string }),
    };
  }
  return { schemaVersion: STATE_SCHEMA_VERSION, repositories };
}

export async function writeStateFile(path: string, state: SourceRefStateFile): Promise<void> {
  await atomicWriteJson(path, validateStateFile(state, path));
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  location: string,
  optional: readonly string[] = [],
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw invalid(path, `${location} has unknown field '${unknown[0]}'`);
  const missing = allowed.filter((key) => !optional.includes(key) && !(key in value));
  if (missing.length) throw invalid(path, `${location} is missing field '${missing[0]}'`);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, reason: string, cause?: unknown): StateFileValidationError {
  return new StateFileValidationError(
    path,
    reason,
    cause === undefined ? undefined : { cause },
  );
}
