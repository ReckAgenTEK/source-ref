import { assertEquals } from "@std/assert";
import { SourceRefStore } from "../src/mod.ts";
import { cleanup, createGitFixture } from "./test_helpers.ts";

Deno.test("different repositories retain concurrent lock and state updates", async () => {
  const fixture = await createGitFixture();
  const project = await Deno.makeTempDir({ prefix: "source-ref-concurrent-" });
  try {
    const store = new SourceRefStore({ projectRoot: project });
    await Promise.all([
      store.ensure({
        id: { provider: "local", name: "one" },
        url: fixture.remote,
        mode: "pinned",
        ref: { kind: "tag", value: "v1" },
      }),
      store.ensure({
        id: { provider: "local", name: "two" },
        url: fixture.remote,
        mode: "pinned",
        ref: { kind: "tag", value: "v1" },
      }),
    ]);
    assertEquals((await store.list()).map((entry) => entry.key), ["local/one", "local/two"]);
    const state = JSON.parse(await Deno.readTextFile(`${project}/.source-ref/state.json`));
    assertEquals(Object.keys(state.repositories).sort(), ["local/one", "local/two"]);
  } finally {
    await cleanup(project);
    await cleanup(fixture.root);
  }
});
