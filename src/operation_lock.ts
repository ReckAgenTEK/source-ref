import { join } from "@std/path";
import { atomicWriteJson } from "./lockfile.ts";
import { OperationAbortedError, OperationLockedError, SourceRefIoError } from "./errors.ts";
import type { RepositoryId } from "./types.ts";
import { repositoryKey, type RepositoryLayout } from "./layout.ts";

export interface OperationLockOwner {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly operation: string;
  readonly pid: number;
  readonly startedAt: string;
}

export class OperationLock {
  readonly operationId: string;
  readonly #path: string;
  #released = false;

  private constructor(path: string, operationId: string) {
    this.#path = path;
    this.operationId = operationId;
  }

  static async acquire(
    id: RepositoryId,
    layout: RepositoryLayout,
    operation: string,
  ): Promise<OperationLock> {
    await Deno.mkdir(layout.operationLockParent, { recursive: true });
    const operationId = crypto.randomUUID();
    try {
      await Deno.mkdir(layout.operationLockPath);
    } catch (cause) {
      if (cause instanceof Deno.errors.AlreadyExists) {
        throw new OperationLockedError(
          repositoryKey(id),
          layout.operationLockPath,
          await readOwner(layout.operationLockPath),
        );
      }
      throw new SourceRefIoError("acquire operation lock", layout.operationLockPath, { cause });
    }

    const owner: OperationLockOwner = {
      schemaVersion: 1,
      operationId,
      operation,
      pid: Deno.pid,
      startedAt: new Date().toISOString(),
    };
    try {
      await atomicWriteJson(`${layout.operationLockPath}/owner.json`, owner);
    } catch (cause) {
      try {
        await Deno.remove(layout.operationLockPath, { recursive: true });
      } catch {
        // The metadata error is more useful than a cleanup error here.
      }
      throw cause;
    }
    return new OperationLock(layout.operationLockPath, operationId);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    try {
      await Deno.remove(this.#path, { recursive: true });
      this.#released = true;
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) {
        this.#released = true;
        return;
      }
      throw new SourceRefIoError("release operation lock", this.#path, { cause });
    }
  }
}

export class MetadataLock {
  readonly #path: string;
  #released = false;

  private constructor(path: string) {
    this.#path = path;
  }

  static async acquire(
    locksRoot: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<MetadataLock> {
    await Deno.mkdir(locksRoot, { recursive: true });
    const path = join(locksRoot, ".metadata.lock");
    const started = performance.now();
    while (true) {
      if (signal?.aborted) throw new OperationAbortedError(operation);
      try {
        await Deno.mkdir(path);
        break;
      } catch (cause) {
        if (!(cause instanceof Deno.errors.AlreadyExists)) {
          throw new SourceRefIoError("acquire metadata lock", path, { cause });
        }
        if (performance.now() - started >= 1_000) {
          throw new OperationLockedError("source-ref metadata", path, await readOwner(path));
        }
        await abortableDelay(10, signal, operation);
      }
    }

    try {
      await atomicWriteJson(join(path, "owner.json"), {
        schemaVersion: 1,
        operationId: crypto.randomUUID(),
        operation,
        pid: Deno.pid,
        startedAt: new Date().toISOString(),
      });
    } catch (cause) {
      try {
        await Deno.remove(path, { recursive: true });
      } catch {
        // Preserve the metadata write error.
      }
      throw cause;
    }
    return new MetadataLock(path);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    try {
      await Deno.remove(this.#path, { recursive: true });
      this.#released = true;
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) {
        this.#released = true;
        return;
      }
      throw new SourceRefIoError("release metadata lock", this.#path, { cause });
    }
  }
}

async function readOwner(lockPath: string): Promise<unknown> {
  try {
    const text = await Deno.readTextFile(`${lockPath}/owner.json`);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperationAbortedError(operation));
      return;
    }
    const timeout = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(new OperationAbortedError(operation));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
