import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DirtyWorktreeError,
  GitCommandError,
  LockedCommitMismatchError,
  SourceRefStore,
} from "../src/mod.ts";
import { assertGitCommit, cleanup, createGitFixture } from "./test_helpers.ts";

Deno.test("branch workflow tracks upstream, pulls only fast-forward, and rejects divergence", async () => {
  const fixture = await createGitFixture();
  const project = await Deno.makeTempDir({ prefix: "source-ref-branch-" });
  try {
    const store = new SourceRefStore({ projectRoot: project });
    const id = { provider: "local", name: "branch" };
    const initial = await fixture.commit();
    const ensured = await store.ensure({
      id,
      url: fixture.remote,
      mode: "branch",
      ref: { kind: "branch", value: "main" },
    });
    assertEquals(ensured.resolvedCommit, initial);
    assertEquals(await fixture.git(["branch", "--show-current"], ensured.checkoutPath), "main");
    assertEquals(await fixture.git(["rev-parse", "@{upstream}"], ensured.checkoutPath), initial);

    const remoteAdvance = await fixture.advance("branch pull");
    const pulled = await store.pull(id);
    assertEquals(pulled.resolvedCommit, remoteAdvance);
    await assertGitCommit(fixture.git, ensured.checkoutPath, remoteAdvance);

    const tracked = join(ensured.checkoutPath, "fixture.txt");
    await Deno.writeTextFile(tracked, "dirty\n");
    const lockBeforeDirty = await Deno.readTextFile(join(project, "source-ref.lock.json"));
    await fixture.advance("blocked by dirty checkout");
    await assertRejects(() => store.pull(id), DirtyWorktreeError);
    assertEquals(await Deno.readTextFile(tracked), "dirty\n");
    assertEquals(await Deno.readTextFile(join(project, "source-ref.lock.json")), lockBeforeDirty);
    await fixture.git(["checkout", "--", "fixture.txt"], ensured.checkoutPath);

    const caughtUp = await store.pull(id);
    await fixture.advance("remote moves beyond deleted cache");
    await Deno.remove(store.path(id, { repositoryRoot: true }), { recursive: true });
    const rebuilt = await store.sync(id);
    assertEquals(rebuilt[0].resolvedCommit, caughtUp.resolvedCommit);
    await assertGitCommit(fixture.git, ensured.checkoutPath, caughtUp.resolvedCommit);
    assertEquals((await store.status(id))[0].aheadBehind?.behind, 1);
    await store.pull(id);

    const lockBeforeDivergence = await Deno.readTextFile(join(project, "source-ref.lock.json"));
    await Deno.writeTextFile(join(ensured.checkoutPath, "local.txt"), "local commit\n");
    await fixture.git(["add", "--", "local.txt"], ensured.checkoutPath);
    await fixture.git(["commit", "-m", "local divergence"], ensured.checkoutPath);
    await fixture.advance("remote divergence");

    await assertRejects(() => store.pull(id), GitCommandError);
    assertEquals(
      await Deno.readTextFile(join(project, "source-ref.lock.json")),
      lockBeforeDivergence,
    );
    await assertRejects(() => store.sync(id), LockedCommitMismatchError);
    assertEquals(
      JSON.parse(lockBeforeDivergence).repositories["local/branch"].resolvedCommit,
      await fixture.git(["rev-parse", "HEAD~1"], fixture.worktree),
    );
  } finally {
    await cleanup(project);
    await cleanup(fixture.root);
  }
});
