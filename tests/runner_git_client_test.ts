import { assertEquals, assertInstanceOf, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
  CommandRunnerAbortError,
  DenoCommandRunner,
} from "../src/command_runner.ts";
import { GitCommandError, OperationAbortedError } from "../src/errors.ts";
import { GitClient } from "../src/git_client.ts";

class FakeRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  readonly #results: Array<CommandResult | Error>;

  constructor(results: Array<Partial<CommandResult> | Error>) {
    this.#results = results.map((result) =>
      result instanceof Error ? result : {
        success: result.success ?? true,
        code: result.code ?? 0,
        signal: result.signal ?? null,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        stdoutTruncated: result.stdoutTruncated ?? false,
        stderrTruncated: result.stderrTruncated ?? false,
        durationMs: result.durationMs ?? 0,
      }
    );
  }

  run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    const result = this.#results.shift();
    if (!result) throw new Error("Fake runner has no queued result");
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }
}

Deno.test("Deno runner invokes an executable directly and bounds captured output", async () => {
  const runner = new DenoCommandRunner();
  const result = await runner.run({
    executable: "git",
    args: ["--version"],
    maxOutputBytes: 4,
  });
  assertEquals(result.success, true);
  assertEquals(result.stdout.length, 4);
  assertEquals(result.stdoutTruncated, true);
});

Deno.test("Deno runner rejects an already-aborted command", async () => {
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () =>
      new DenoCommandRunner().run({
        executable: "git",
        args: ["--version"],
        signal: controller.signal,
      }),
    CommandRunnerAbortError,
  );
});

Deno.test("Git client normalizes branches and peels annotated tags", async () => {
  const object = "1".repeat(40);
  const tagObject = "2".repeat(40);
  const peeled = "3".repeat(40);
  const runner = new FakeRunner([{
    stdout: `${object}\trefs/heads/main\n${tagObject}\trefs/tags/v1\n${peeled}\trefs/tags/v1^{}\n`,
  }]);
  const refs = await new GitClient(runner).listRemoteRefs("https://example.invalid/repo.git");
  assertEquals(refs, [
    { kind: "branch", name: "main", commit: object },
    { kind: "tag", name: "v1", commit: peeled },
  ]);
  assertEquals(runner.requests[0].executable, "git");
  assertEquals(runner.requests[0].args, [
    "ls-remote",
    "--heads",
    "--tags",
    "--",
    "https://example.invalid/repo.git",
  ]);
  assertEquals(runner.requests[0].env?.GIT_TERMINAL_PROMPT, "0");
});

Deno.test("Git client returns structured revision descriptions without a shell", async () => {
  const commit = "9df02121d0d87c17173f79d55692bed9cb65722c";
  const runner = new FakeRunner([{ stdout: "0.16.0-135-g9df02121d\n" }]);
  const description = await new GitClient(runner).describeRevision(
    "/managed/git-src",
    commit,
    "*.*.*",
    9,
  );
  assertEquals(description, {
    commit,
    tag: "0.16.0",
    commitsSinceTag: 135,
    abbreviatedCommit: "9df02121d",
  });
  assertEquals(runner.requests[0].args, [
    "-C",
    "/managed/git-src",
    "describe",
    "--match=*.*.*",
    "--tags",
    "--abbrev=9",
    "--long",
    "--always",
    commit,
  ]);
});

Deno.test("Git command errors carry bounded structured and redacted diagnostics", async () => {
  const runner = new FakeRunner([{
    success: false,
    code: 128,
    stderr: "fatal: unable to access 'https://alice:secret@example.invalid/repo.git'",
    stderrTruncated: true,
  }]);
  const error = await assertRejects(
    () => new GitClient(runner).listRemoteRefs("https://alice:secret@example.invalid/repo.git"),
    GitCommandError,
  );
  assertEquals(error.exitCode, 128);
  assertEquals(error.message.includes("secret"), false);
  assertEquals(JSON.stringify(error.details).includes("secret"), false);
  assertStringIncludes(JSON.stringify(error.details), "stderrTruncated");
});

Deno.test("Git client maps runner cancellation to a public abort error", async () => {
  const runner = new FakeRunner([new CommandRunnerAbortError()]);
  const error = await assertRejects(
    () => new GitClient(runner).version(),
    OperationAbortedError,
  );
  assertInstanceOf(error, OperationAbortedError);
});

Deno.test("Git client rejects branch names that could be parsed as options", async () => {
  const runner = new FakeRunner([]);
  await assertRejects(
    () => new GitClient(runner).validateRef({ kind: "branch", value: "--orphan" }),
  );
  assertEquals(runner.requests.length, 0);
});
