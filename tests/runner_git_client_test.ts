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

Deno.test("Git client strictly resolves 40- and 64-hex symbolic remote HEADs", async () => {
  for (const rawCommit of ["A".repeat(40), "B".repeat(64)]) {
    const runner = new FakeRunner([{
      stdout: `ref: refs/heads/feature/topic\tHEAD\n${rawCommit}\tHEAD\n`,
    }]);
    const head = await new GitClient(runner).resolveRemoteHead(
      "https://example.invalid/repo.git",
    );
    assertEquals(head, { branch: "feature/topic", commit: rawCommit.toLowerCase() });
    assertEquals(runner.requests[0].executable, "git");
    assertEquals(runner.requests[0].args, [
      "ls-remote",
      "--symref",
      "--",
      "https://example.invalid/repo.git",
      "HEAD",
    ]);
  }
});

Deno.test("Git client rejects malformed symbolic remote HEAD output", async () => {
  const commit = "1".repeat(40);
  const outputs = [
    `ref: refs/heads/main HEAD\n${commit}\tHEAD\n`,
    `ref: refs/tags/v1\tHEAD\n${commit}\tHEAD\n`,
    `ref: refs/heads/main\tHEAD\n${commit}\tHEAD\nunexpected\n`,
    `ref: refs/heads/main\tHEAD\nref: refs/heads/other\tHEAD\n${commit}\tHEAD\n`,
  ];
  for (const stdout of outputs) {
    const error = await assertRejects(
      () => new GitClient(new FakeRunner([{ stdout }])).resolveRemoteHead("remote.git"),
      GitCommandError,
    );
    assertEquals(error.code, "GIT_COMMAND_FAILED");
    assertEquals(error.exitCode, 0);
  }
});

Deno.test("Git client rejects invalid symbolic remote HEAD branch names", async () => {
  const commit = "1".repeat(40);
  for (
    const branch of [
      "bad branch",
      "bad..branch",
      "bad~branch",
      "bad/",
      ".hidden/main",
      "topic.lock",
      "HEAD",
    ]
  ) {
    const error = await assertRejects(
      () =>
        new GitClient(
          new FakeRunner([{
            stdout: `ref: refs/heads/${branch}\tHEAD\n${commit}\tHEAD\n`,
          }]),
        ).resolveRemoteHead("remote.git"),
      GitCommandError,
    );
    assertEquals(error.details.reason, "invalid symbolic branch name");
  }
});

Deno.test("Git client rejects a remote HEAD without a symbolic branch", async () => {
  const runner = new FakeRunner([{ stdout: `${"1".repeat(40)}\tHEAD\n` }]);
  const error = await assertRejects(
    () => new GitClient(runner).resolveRemoteHead("remote.git"),
    GitCommandError,
  );
  assertEquals(error.details.reason, "missing symbolic HEAD mapping");
});

Deno.test("Git client rejects an invalid remote HEAD commit", async () => {
  for (const commit of ["1".repeat(39), "g".repeat(40), "1".repeat(65)]) {
    const runner = new FakeRunner([{
      stdout: `ref: refs/heads/main\tHEAD\n${commit}\tHEAD\n`,
    }]);
    await assertRejects(
      () => new GitClient(runner).resolveRemoteHead("remote.git"),
      GitCommandError,
    );
  }
});

Deno.test("Git client maps remote HEAD cancellation to a public abort error", async () => {
  const runner = new FakeRunner([new CommandRunnerAbortError()]);
  const controller = new AbortController();
  const error = await assertRejects(
    () => new GitClient(runner).resolveRemoteHead("remote.git", controller.signal),
    OperationAbortedError,
  );
  assertEquals(error.details.operation, "remote HEAD resolution");
  assertEquals(runner.requests[0].signal, controller.signal);
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
