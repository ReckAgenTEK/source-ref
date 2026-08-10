import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  LockFileValidationError,
  OperationLockedError,
  StateFileValidationError,
} from "../src/errors.ts";
import { createRepositoryLayout, createStoreLayout } from "../src/layout.ts";
import { atomicWriteJson, readLockFile, validateLockFile, writeLockFile } from "../src/lockfile.ts";
import { OperationLock } from "../src/operation_lock.ts";
import { validateStateFile } from "../src/state.ts";
import { cleanup } from "./test_helpers.ts";

const COMMIT = "a".repeat(40);

Deno.test("lock and state schemas strictly validate version 1", () => {
  const valid = {
    schemaVersion: 1 as const,
    repositories: {
      "local/repo": {
        url: "/tmp/repo.git",
        mode: "pinned" as const,
        requested: { kind: "tag" as const, value: "v1" },
        resolvedCommit: COMMIT,
      },
    },
  };
  assertEquals(validateLockFile(valid), valid);
  assertThrows(
    () => validateLockFile({ ...valid, schemaVersion: 2 }),
    LockFileValidationError,
  );
  assertThrows(
    () => validateLockFile({ ...valid, unexpected: true }),
    LockFileValidationError,
  );
  assertThrows(
    () =>
      validateLockFile({
        schemaVersion: 1,
        repositories: {
          "local/repo": {
            ...valid.repositories["local/repo"],
            mode: "branch",
          },
        },
      }),
    LockFileValidationError,
  );

  assertThrows(
    () =>
      validateStateFile({
        schemaVersion: 1,
        repositories: {
          "local/repo": {
            url: "/tmp/repo",
            identity: "local:/tmp/repo",
            repositoryHome: "/tmp/root/local/repo",
            checkoutPath: "/tmp/root/local/repo/git-src",
            lastOperationAt: "not-a-date",
          },
        },
      }),
    StateFileValidationError,
  );
});

Deno.test("atomic JSON writes replace complete files and leave no temporary siblings", async () => {
  const root = await Deno.makeTempDir({ prefix: "source-ref-atomic-" });
  try {
    const path = join(root, "source-ref.lock.json");
    const first = {
      schemaVersion: 1 as const,
      repositories: {},
    };
    await writeLockFile(path, first);
    await atomicWriteJson(path, { schemaVersion: 1, repositories: {} });
    assertEquals(await readLockFile(path), first);
    assertEquals(
      [...Deno.readDirSync(root)].filter((entry) => entry.name.endsWith(".tmp")).length,
      0,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("operation locks contend and are never removed by a second acquirer", async () => {
  const root = await Deno.makeTempDir({ prefix: "source-ref-lock-" });
  try {
    const storeLayout = createStoreLayout({ projectRoot: root });
    const id = { provider: "local", name: "repo" };
    const repositoryLayout = createRepositoryLayout(storeLayout, id);
    const first = await OperationLock.acquire(id, repositoryLayout, "first");
    await assertRejects(
      () => OperationLock.acquire(id, repositoryLayout, "second"),
      OperationLockedError,
    );
    assertEquals((await Deno.stat(repositoryLayout.operationLockPath)).isDirectory, true);
    await first.release();
    const next = await OperationLock.acquire(id, repositoryLayout, "next");
    await next.release();
  } finally {
    await cleanup(root);
  }
});
