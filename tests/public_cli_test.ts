import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import * as publicApi from "../src/mod.ts";
import { runCli } from "../src/cli.ts";
import { cleanup } from "./test_helpers.ts";

Deno.test("public module exposes domain API but not Git internals", () => {
  assertEquals(typeof publicApi.SourceRefStore, "function");
  assertEquals(publicApi.SOURCE_REF_SCHEMA_VERSION, 1);
  assertEquals(publicApi.MINIMUM_GIT_VERSION, "2.20.0");
  const keys = Object.keys(publicApi);
  assertEquals(keys.includes("GitClient"), false);
  assertEquals(keys.includes("DenoCommandRunner"), false);
  assertEquals(keys.includes("parseRepositoryUrl"), false);
});

Deno.test("CLI path stdout is composable and JSON errors are stable", async () => {
  const root = await Deno.makeTempDir({ prefix: "source-ref-cli-" });
  try {
    let stdout = "";
    let stderr = "";
    const io = {
      stdout: (text: string) => {
        stdout += text;
        return Promise.resolve();
      },
      stderr: (text: string) => {
        stderr += text;
        return Promise.resolve();
      },
    };
    const code = await runCli(["path", "local/repo", "--project-root", root], io);
    assertEquals(code, 0);
    assertEquals(stdout, `${join(root, ".source-ref", "local", "repo", "git-src")}\n`);
    assertEquals(stderr, "");

    stdout = "";
    stderr = "";
    const errorCode = await runCli(["status", "invalid-id", "--project-root", root, "--json"], io);
    assertEquals(errorCode, 1);
    const document = JSON.parse(stdout);
    assertEquals(document.schemaVersion, 1);
    assertEquals(document.error.code, "INVALID_REPOSITORY_ID");
    assertEquals(stderr, "");
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI doctor reports real Git as versioned JSON", async () => {
  let stdout = "";
  const code = await runCli(["doctor", "--json"], {
    stdout: (text) => {
      stdout += text;
      return Promise.resolve();
    },
    stderr: () => Promise.resolve(),
  });
  const document = JSON.parse(stdout);
  assertEquals(code, 0);
  assertEquals(document.schemaVersion, 1);
  assertEquals(document.command, "doctor");
  assertEquals(document.result.git.available, true);
  assertStringIncludes(document.result.git.version, ".");
});
