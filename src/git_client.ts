import { MINIMUM_GIT_VERSION } from "./constants.ts";
import {
  GitCommandError,
  GitNotFoundError,
  GitOutputTruncatedError,
  GitVersionUnsupportedError,
  InvalidGitRefError,
  OperationAbortedError,
} from "./errors.ts";
import {
  type CommandResult,
  type CommandRunner,
  CommandRunnerAbortError,
  DenoCommandRunner,
} from "./command_runner.ts";
import { redactUrl } from "./repository_url.ts";
import type { GitRef, RemoteHead, RemoteRef, RemoteRefKind, RevisionDescription } from "./types.ts";

const PARSE_OUTPUT_LIMIT = 16 * 1024 * 1024;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

interface GitRunOptions {
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  readonly operation?: string;
  readonly progress?: boolean;
}

type GitProgressHandler = (chunk: Uint8Array) => void | Promise<void>;

export class GitClient {
  readonly #runner: CommandRunner;
  readonly #onProgress: GitProgressHandler | undefined;

  constructor(
    runner: CommandRunner = new DenoCommandRunner(),
    onProgress?: GitProgressHandler,
  ) {
    this.#runner = runner;
    this.#onProgress = onProgress;
  }

  async version(signal?: AbortSignal): Promise<string> {
    const result = await this.#runChecked(["--version"], undefined, {
      signal,
      operation: "version",
    });
    const match = /git version (\d+\.\d+(?:\.\d+)?)/i.exec(result.stdout.trim());
    if (!match) {
      throw new GitCommandError("Git returned an unrecognized version string", {
        exitCode: 0,
        command: "git",
        args: ["--version"],
      });
    }
    return normalizeVersion(match[1]);
  }

  async assertSupportedVersion(signal?: AbortSignal): Promise<string> {
    const version = await this.version(signal);
    if (compareVersions(version, MINIMUM_GIT_VERSION) < 0) {
      throw new GitVersionUnsupportedError(version, MINIMUM_GIT_VERSION);
    }
    return version;
  }

  async validateRef(ref: GitRef, signal?: AbortSignal): Promise<void> {
    if (!ref.value || ref.value.length > 1024 || /[\0\r\n]/.test(ref.value)) {
      throw new InvalidGitRefError(
        ref.kind,
        ref.value,
        "the value is empty, too long, or contains control characters",
      );
    }
    if (ref.value.startsWith("-") || ref.kind === "branch" && ref.value === "HEAD") {
      throw new InvalidGitRefError(
        ref.kind,
        ref.value,
        "the ref could be interpreted as a Git option or symbolic name",
      );
    }
    if (ref.kind === "commit") {
      if (!COMMIT_PATTERN.test(ref.value)) {
        throw new InvalidGitRefError(
          ref.kind,
          ref.value,
          "an exact 40- or 64-character object ID is required",
        );
      }
      return;
    }

    const checkArguments = ref.kind === "branch"
      ? ["check-ref-format", "--branch", ref.value]
      : ["check-ref-format", `refs/tags/${ref.value}`];
    const result = await this.#run(checkArguments, undefined, {
      signal,
      operation: "ref validation",
    });
    if (!result.success) {
      throw new InvalidGitRefError(ref.kind, ref.value, "Git rejected the ref name");
    }
  }

  async listRemoteRefs(
    url: string,
    kind?: RemoteRefKind,
    signal?: AbortSignal,
  ): Promise<RemoteRef[]> {
    const filters = kind === "tag"
      ? ["--tags"]
      : kind === "branch"
      ? ["--heads"]
      : ["--heads", "--tags"];
    const result = await this.#runChecked(
      ["ls-remote", ...filters, "--", url],
      undefined,
      { signal, maxOutputBytes: PARSE_OUTPUT_LIMIT, operation: "remote ref listing" },
    );
    if (result.stdoutTruncated) throw new GitOutputTruncatedError("remote ref listing");
    return parseRemoteRefs(result.stdout, kind);
  }

  async resolveRemoteHead(url: string, signal?: AbortSignal): Promise<RemoteHead> {
    const result = await this.#runChecked(
      ["ls-remote", "--symref", "--", url, "HEAD"],
      undefined,
      { signal, maxOutputBytes: PARSE_OUTPUT_LIMIT, operation: "remote HEAD resolution" },
    );
    if (result.stdoutTruncated) throw new GitOutputTruncatedError("remote HEAD resolution");
    return parseRemoteHead(result.stdout);
  }

  async describeRevision(
    path: string,
    commit: string,
    tagPattern = "*",
    abbreviationLength = 12,
    signal?: AbortSignal,
  ): Promise<RevisionDescription> {
    const normalizedCommit = commit.toLowerCase();
    if (!COMMIT_PATTERN.test(normalizedCommit)) {
      throw new InvalidGitRefError("commit", commit, "an exact object ID is required");
    }
    if (
      tagPattern.length === 0 || tagPattern.length > 1024 ||
      /[\0\r\n]/.test(tagPattern)
    ) {
      throw new InvalidGitRefError("tag", tagPattern, "tag pattern is empty, too long, or unsafe");
    }
    if (
      !Number.isSafeInteger(abbreviationLength) || abbreviationLength < 4 || abbreviationLength > 64
    ) {
      throw new TypeError("revision abbreviation length must be an integer from 4 through 64");
    }
    const result = await this.#runChecked(
      [
        "-C",
        path,
        "describe",
        `--match=${tagPattern}`,
        "--tags",
        `--abbrev=${abbreviationLength}`,
        "--long",
        "--always",
        normalizedCommit,
      ],
      undefined,
      { signal, operation: "revision description" },
    );
    return parseRevisionDescription(result.stdout, normalizedCommit);
  }

  async clone(url: string, destination: string, signal?: AbortSignal): Promise<void> {
    await this.#runChecked(
      ["clone", "--origin", "origin", "--", url, destination],
      undefined,
      { signal, operation: "clone", progress: true },
    );
  }

  async isRepository(path: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.#run(["-C", path, "rev-parse", "--is-inside-work-tree"], undefined, {
      signal,
      operation: "repository validation",
    });
    return result.success && result.stdout.trim() === "true";
  }

  async remoteUrl(path: string, signal?: AbortSignal): Promise<string> {
    const result = await this.#runChecked(["-C", path, "remote", "get-url", "origin"], undefined, {
      signal,
      operation: "remote URL query",
    });
    return result.stdout.trim();
  }

  async currentCommit(path: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.#run(
      ["-C", path, "rev-parse", "--verify", "HEAD^{commit}"],
      undefined,
      { signal, operation: "current commit query" },
    );
    if (!result.success) return null;
    return parseCommit(result.stdout, "current commit");
  }

  async currentBranch(path: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.#run(
      ["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"],
      undefined,
      { signal, operation: "current branch query" },
    );
    return result.success ? result.stdout.trim() : null;
  }

  async worktreeStatus(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ dirty: boolean; changes: string[]; truncated: boolean }> {
    const result = await this.#runChecked(
      ["-C", path, "status", "--porcelain=v1", "--untracked-files=all"],
      undefined,
      { signal, operation: "worktree status" },
    );
    const changes = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 100);
    return {
      dirty: changes.length > 0 || result.stdoutTruncated,
      changes,
      truncated: result.stdoutTruncated,
    };
  }

  async hasCommit(path: string, commit: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.#run(
      ["-C", path, "cat-file", "-e", `${commit}^{commit}`],
      undefined,
      { signal, operation: "commit availability query" },
    );
    return result.success;
  }

  async fetchRef(path: string, ref: GitRef, signal?: AbortSignal): Promise<void> {
    const refspec = ref.kind === "tag"
      ? `+refs/tags/${ref.value}:refs/tags/${ref.value}`
      : ref.kind === "branch"
      ? `+refs/heads/${ref.value}:refs/remotes/origin/${ref.value}`
      : ref.value;
    await this.#runChecked(
      ["-C", path, "fetch", "--no-tags", "--force", "--", "origin", refspec],
      undefined,
      { signal, operation: "fetch", progress: true },
    );
  }

  async fetchCommit(path: string, commit: string, signal?: AbortSignal): Promise<void> {
    await this.#runChecked(
      ["-C", path, "fetch", "--no-tags", "--", "origin", commit],
      undefined,
      { signal, operation: "locked commit fetch", progress: true },
    );
  }

  async resolveLocalRef(path: string, ref: GitRef, signal?: AbortSignal): Promise<string> {
    const revision = ref.kind === "tag"
      ? `refs/tags/${ref.value}^{commit}`
      : ref.kind === "branch"
      ? `refs/remotes/origin/${ref.value}^{commit}`
      : `${ref.value}^{commit}`;
    const result = await this.#runChecked(
      ["-C", path, "rev-parse", "--verify", revision],
      undefined,
      { signal, operation: "ref resolution" },
    );
    return parseCommit(result.stdout, "ref resolution");
  }

  async checkoutDetached(path: string, commit: string, signal?: AbortSignal): Promise<void> {
    await this.#runChecked(
      ["-C", path, "checkout", "--detach", commit],
      undefined,
      { signal, operation: "detached checkout" },
    );
  }

  async localBranchCommit(
    path: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const result = await this.#run(
      ["-C", path, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
      undefined,
      { signal, operation: "local branch query" },
    );
    return result.success ? parseCommit(result.stdout, "local branch query") : null;
  }

  async checkoutBranch(path: string, branch: string, signal?: AbortSignal): Promise<void> {
    await this.#runChecked(["-C", path, "checkout", branch], undefined, {
      signal,
      operation: "branch checkout",
    });
  }

  async createBranch(
    path: string,
    branch: string,
    commit: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#runChecked(["-C", path, "checkout", "-b", branch, commit], undefined, {
      signal,
      operation: "branch creation",
    });
  }

  async recreateBranch(
    path: string,
    branch: string,
    commit: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#runChecked(["-C", path, "checkout", "-B", branch, commit], undefined, {
      signal,
      operation: "generated branch recreation",
    });
  }

  async setUpstream(path: string, branch: string, signal?: AbortSignal): Promise<void> {
    await this.#runChecked(
      ["-C", path, "branch", `--set-upstream-to=origin/${branch}`, "--", branch],
      undefined,
      { signal, operation: "upstream configuration" },
    );
  }

  async fastForwardTo(path: string, commit: string, signal?: AbortSignal): Promise<void> {
    await this.#runChecked(["-C", path, "merge", "--ff-only", commit], undefined, {
      signal,
      operation: "fast-forward",
    });
  }

  async isAncestor(
    path: string,
    ancestor: string,
    descendant: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.#run(
      ["-C", path, "merge-base", "--is-ancestor", ancestor, descendant],
      undefined,
      { signal, operation: "ancestry query" },
    );
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    this.#throwForResult(
      result,
      ["-C", path, "merge-base", "--is-ancestor", ancestor, descendant],
      path,
    );
  }

  async pullFastForwardOnly(path: string, signal?: AbortSignal): Promise<void> {
    await this.#runChecked(["-C", path, "pull", "--ff-only"], undefined, {
      signal,
      operation: "pull --ff-only",
      progress: true,
    });
  }

  async aheadBehind(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ ahead: number; behind: number } | null> {
    const result = await this.#run(
      ["-C", path, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      undefined,
      { signal, operation: "ahead/behind query" },
    );
    if (!result.success) return null;
    const match = /^(\d+)\s+(\d+)$/.exec(result.stdout.trim());
    if (!match) return null;
    return { ahead: Number(match[1]), behind: Number(match[2]) };
  }

  async #runChecked(
    args: readonly string[],
    cwd?: string,
    options: GitRunOptions = {},
  ): Promise<CommandResult> {
    const result = await this.#run(args, cwd, options);
    if (!result.success) this.#throwForResult(result, args, cwd);
    return result;
  }

  async #run(
    args: readonly string[],
    cwd?: string,
    options: GitRunOptions = {},
  ): Promise<CommandResult> {
    try {
      const progress = options.progress === true && this.#onProgress !== undefined;
      return await this.#runner.run({
        executable: "git",
        args: progress ? withProgressArgument(args) : args,
        cwd,
        env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        signal: options.signal,
        maxOutputBytes: options.maxOutputBytes,
        onStderr: progress ? this.#onProgress : undefined,
      });
    } catch (cause) {
      if (
        options.signal?.aborted || cause instanceof CommandRunnerAbortError || isAbortError(cause)
      ) {
        throw new OperationAbortedError(options.operation ?? "Git command", { cause });
      }
      if (cause instanceof Deno.errors.NotFound) throw new GitNotFoundError({ cause });
      throw cause;
    }
  }

  #throwForResult(result: CommandResult, args: readonly string[], cwd?: string): never {
    const redactedArgs = args.map(redactArgument);
    const stderr = redactDiagnostic(result.stderr.trim());
    const stdout = redactDiagnostic(result.stdout.trim());
    const diagnostic = stderr || stdout || "Git exited without diagnostics";
    throw new GitCommandError(`Git command failed with exit code ${result.code}: ${diagnostic}`, {
      exitCode: result.code,
      signal: result.signal,
      command: "git",
      args: redactedArgs,
      cwd,
      stderr,
      stdout,
      stderrTruncated: result.stderrTruncated,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
}

function withProgressArgument(args: readonly string[]): readonly string[] {
  const commandIndex = args.findIndex((argument) =>
    argument === "clone" || argument === "fetch" || argument === "pull"
  );
  if (commandIndex < 0) throw new TypeError("Git progress requires clone, fetch, or pull");
  return [...args.slice(0, commandIndex + 1), "--progress", ...args.slice(commandIndex + 1)];
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function normalizeVersion(version: string): string {
  const parts = version.split(".");
  while (parts.length < 3) parts.push("0");
  return parts.slice(0, 3).join(".");
}

function parseRemoteRefs(output: string, kind?: RemoteRefKind): RemoteRef[] {
  const directTags = new Map<string, string>();
  const peeledTags = new Map<string, string>();
  const branches = new Map<string, string>();

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(line);
    if (!match) continue;
    const commit = match[1].toLowerCase();
    const ref = match[2];
    if (ref.startsWith("refs/heads/")) {
      branches.set(ref.slice("refs/heads/".length), commit);
    } else if (ref.startsWith("refs/tags/") && ref.endsWith("^{}")) {
      peeledTags.set(ref.slice("refs/tags/".length, -3), commit);
    } else if (ref.startsWith("refs/tags/")) {
      directTags.set(ref.slice("refs/tags/".length), commit);
    }
  }

  const entries: RemoteRef[] = [];
  if (kind !== "tag") {
    for (const [name, commit] of branches) entries.push({ kind: "branch", name, commit });
  }
  if (kind !== "branch") {
    for (const [name, directCommit] of directTags) {
      entries.push({ kind: "tag", name, commit: peeledTags.get(name) ?? directCommit });
    }
  }
  return entries.sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)
  );
}

function parseRemoteHead(output: string): RemoteHead {
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();

  let branch: string | null = null;
  let commit: string | null = null;
  for (const line of lines) {
    const symbolic = /^ref: refs\/heads\/([^\0\t\r\n]+)\tHEAD$/.exec(line);
    if (symbolic) {
      if (branch !== null) throw invalidRemoteHead("multiple symbolic HEAD mappings");
      branch = symbolic[1];
      continue;
    }

    const direct = /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/i.exec(line);
    if (direct) {
      if (commit !== null) throw invalidRemoteHead("multiple HEAD commits");
      commit = direct[1].toLowerCase();
      continue;
    }

    throw invalidRemoteHead("unrecognized output");
  }

  if (branch === null) throw invalidRemoteHead("missing symbolic HEAD mapping");
  if (commit === null) throw invalidRemoteHead("missing HEAD commit");
  if (!isValidBranchName(branch)) throw invalidRemoteHead("invalid symbolic branch name");
  return { branch, commit };
}

function isValidBranchName(value: string): boolean {
  if (
    value.length === 0 || value.length > 1024 || value === "@" || value === "HEAD" ||
    value.startsWith("-") || value.startsWith("/") || value.endsWith("/") ||
    value.endsWith(".") || value.includes("..") || value.includes("//") ||
    value.includes("@{") || /[~^:?*\\[]/.test(value) ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x20 || code === 0x7f;
    })
  ) return false;
  return value.split("/").every((component) =>
    component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock")
  );
}

function invalidRemoteHead(reason: string): GitCommandError {
  return new GitCommandError(`Git returned an invalid symbolic remote HEAD: ${reason}`, {
    exitCode: 0,
    operation: "remote HEAD resolution",
    reason,
  });
}

function parseCommit(output: string, operation: string): string {
  const commit = output.trim().toLowerCase();
  if (!COMMIT_PATTERN.test(commit)) {
    throw new GitCommandError(`Git returned an invalid object ID during ${operation}`, {
      exitCode: 0,
      operation,
    });
  }
  return commit;
}

function parseRevisionDescription(output: string, commit: string): RevisionDescription {
  const description = output.trim();
  const tagged = /^(.*)-([0-9]+)-g([0-9a-f]+)$/i.exec(description);
  if (tagged) {
    const tag = tagged[1];
    const commitsSinceTag = Number(tagged[2]);
    const abbreviatedCommit = tagged[3].toLowerCase();
    if (
      tag.length === 0 || !Number.isSafeInteger(commitsSinceTag) ||
      !commit.startsWith(abbreviatedCommit)
    ) {
      throw invalidRevisionDescription(description);
    }
    return { commit, tag, commitsSinceTag, abbreviatedCommit };
  }
  const abbreviatedCommit = description.toLowerCase();
  if (!/^[0-9a-f]{4,64}$/.test(abbreviatedCommit) || !commit.startsWith(abbreviatedCommit)) {
    throw invalidRevisionDescription(description);
  }
  return { commit, tag: null, commitsSinceTag: null, abbreviatedCommit };
}

function invalidRevisionDescription(description: string): GitCommandError {
  return new GitCommandError("Git returned an invalid revision description", {
    exitCode: 0,
    operation: "revision description",
    stdout: description,
  });
}

function redactArgument(argument: string): string {
  if (argument.includes("://") || /^[^\s@]+@[^\s:]+:/.test(argument)) return redactUrl(argument);
  return argument;
}

function redactDiagnostic(value: string): string {
  return value.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"<>]+/g, (url) => redactUrl(url));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && error.name === "AbortError";
}
