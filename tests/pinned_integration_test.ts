import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DirtyWorktreeError,
  GitCommandError,
  OperationLockedError,
  RepositoryIdCollisionError,
  SourceRefStore,
} from "../src/mod.ts";
import { assertGitCommit, cleanup, createGitFixture } from "./test_helpers.ts";

Deno.test("pinned workflow peels tags, preserves locks, updates explicitly, and protects dirt", async () => {
  const fixture = await createGitFixture();
  const project = await Deno.makeTempDir({ prefix: "source-ref-project-" });
  try {
    const store = new SourceRefStore({ projectRoot: project });
    const id = { provider: "local", name: "fixture" };
    const initial = await fixture.commit();
    const ensured = await store.ensure({
      id,
      url: fixture.remote,
      mode: "pinned",
      ref: { kind: "tag", value: "v1" },
    });
    assertEquals(ensured.resolvedCommit, initial);
    assertEquals(ensured.cloned, true);
    await assertGitCommit(fixture.git, ensured.checkoutPath, initial);
    assertEquals(
      await fixture.git(["symbolic-ref", "-q", "HEAD"], ensured.checkoutPath).catch(() => ""),
      "",
    );

    const tags = await store.listRemoteRefs({ url: fixture.remote, kind: "tag" });
    assertEquals(tags.find((tag) => tag.name === "v1")?.commit, initial);

    const advanced = await fixture.advance("move annotated tag");
    await fixture.git(["tag", "-f", "-a", "v1", "-m", "moved v1"], fixture.worktree);
    await fixture.git(["push", "--force", "origin", "refs/tags/v1"], fixture.worktree);

    const synchronized = await store.sync(id);
    assertEquals(synchronized[0].resolvedCommit, initial);
    await assertGitCommit(fixture.git, ensured.checkoutPath, initial);

    const updated = await store.update(id);
    assertEquals(updated.resolvedCommit, advanced);
    await assertGitCommit(fixture.git, ensured.checkoutPath, advanced);

    const exactCheckout = await store.checkout(id, { kind: "commit", value: initial });
    assertEquals(exactCheckout.resolvedCommit, initial);
    const tagCheckout = await store.checkout(id, { kind: "tag", value: "v1" });
    assertEquals(tagCheckout.resolvedCommit, advanced);
    await fixture.git(["checkout", "--detach", initial], ensured.checkoutPath);
    assertEquals((await store.sync(id))[0].checkoutChanged, true);
    assertEquals((await store.sync(id))[0].checkoutChanged, false);
    await assertGitCommit(fixture.git, ensured.checkoutPath, advanced);

    const lockBeforeFailure = await Deno.readTextFile(join(project, "source-ref.lock.json"));
    await assertRejects(
      () => store.update(id, { ref: { kind: "tag", value: "missing-tag" } }),
      GitCommandError,
    );
    assertEquals(await Deno.readTextFile(join(project, "source-ref.lock.json")), lockBeforeFailure);

    const localChange = join(ensured.checkoutPath, "untracked.txt");
    await Deno.writeTextFile(localChange, "keep me\n");
    await assertRejects(
      () => store.checkout(id, { kind: "commit", value: initial }),
      DirtyWorktreeError,
    );
    assertEquals(await Deno.readTextFile(localChange), "keep me\n");
    assertEquals(await Deno.readTextFile(join(project, "source-ref.lock.json")), lockBeforeFailure);

    const status = (await store.status(id))[0];
    assertEquals(status.dirty, true);
    assertEquals(status.matchesLock, true);
    assertEquals((await store.list())[0].key, "local/fixture");
    assertEquals(store.path(id), ensured.checkoutPath);

    const collisionRemote = join(fixture.root, "collision.git");
    await fixture.git(["init", "--bare", collisionRemote]);
    await assertRejects(
      () =>
        store.ensure({
          id,
          url: collisionRemote,
          mode: "pinned",
          ref: { kind: "tag", value: "v1" },
        }),
      RepositoryIdCollisionError,
    );

    const lockPath = join(project, ".source-ref", ".locks", "local", "fixture.lock");
    await Deno.mkdir(lockPath, { recursive: true });
    await Deno.writeTextFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: 999, operation: "stale" }),
    );
    await assertRejects(() => store.fetch(id), OperationLockedError);
    assertEquals((await Deno.stat(lockPath)).isDirectory, true);
    await Deno.remove(lockPath, { recursive: true });

    await Deno.remove(join(project, "source-ref.lock.json"));
    await Deno.remove(store.path(id, { repositoryRoot: true }), { recursive: true });
    await assertRejects(
      () =>
        store.ensure({
          id,
          url: collisionRemote,
          mode: "pinned",
          ref: { kind: "tag", value: "v1" },
        }),
      RepositoryIdCollisionError,
    );
  } finally {
    await cleanup(project);
    await cleanup(fixture.root);
  }
});

Deno.test("revision description reports the locked commit's tagged ancestry", async () => {
  const fixture = await createGitFixture();
  const project = await Deno.makeTempDir({ prefix: "source-ref-describe-" });
  try {
    const initial = await fixture.commit();
    const advanced = await fixture.advance("describe descendant");
    const store = new SourceRefStore({ projectRoot: project });
    const id = { provider: "local", name: "fixture" };
    await store.ensure({
      id,
      url: fixture.remote,
      mode: "pinned",
      ref: { kind: "commit", value: advanced },
    });
    const description = await store.describeRevision(id, {
      tagPattern: "v*",
      abbreviationLength: 9,
    });
    assertEquals(description.commit, advanced);
    assertEquals(description.tag, "v1");
    assertEquals(description.commitsSinceTag, 1);
    assertEquals(advanced.startsWith(description.abbreviatedCommit), true);
    assertEquals(initial === advanced, false);
  } finally {
    await cleanup(project);
    await cleanup(fixture.root);
  }
});
