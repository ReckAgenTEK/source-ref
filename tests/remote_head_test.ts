import { assertEquals, assertRejects } from "@std/assert";
import {
  InvalidRepositoryUrlError,
  type RemoteHead,
  type ResolveRemoteHeadRequest,
  SourceRefStore,
} from "../src/mod.ts";
import { cleanup, createGitFixture } from "./test_helpers.ts";

Deno.test("store resolves remote HEAD through normalized local repository URLs", async () => {
  const fixture = await createGitFixture();
  try {
    const store = new SourceRefStore({ projectRoot: fixture.root });
    const request: ResolveRemoteHeadRequest = { url: "./remote.git" };
    const head: RemoteHead = await store.resolveRemoteHead(request);
    assertEquals(head, { branch: "main", commit: await fixture.commit() });
  } finally {
    await cleanup(fixture.root);
  }
});

Deno.test("store rejects credential-bearing remote HEAD URLs before invoking Git", async () => {
  const secret = "super-secret";
  const error = await assertRejects(
    () =>
      new SourceRefStore().resolveRemoteHead({
        url: `https://alice:${secret}@example.invalid/repo.git`,
      }),
    InvalidRepositoryUrlError,
  );
  assertEquals(error.code, "INVALID_REPOSITORY_URL");
  assertEquals(JSON.stringify(error.details).includes(secret), false);
});

Deno.test("store redacts secrets from malformed remote HEAD URLs", async () => {
  const secret = "super-secret";
  for (
    const url of [
      ` https://alice:${secret}@[invalid/repo.git`,
      `https://[invalid/repo.git?token=${secret}`,
    ]
  ) {
    const error = await assertRejects(
      () => new SourceRefStore().resolveRemoteHead({ url }),
      InvalidRepositoryUrlError,
    );
    assertEquals(error.code, "INVALID_REPOSITORY_URL");
    assertEquals(error.message.includes(secret), false);
    assertEquals(JSON.stringify(error.details).includes(secret), false);
  }
});
