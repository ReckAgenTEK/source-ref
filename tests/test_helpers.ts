import { join } from "@std/path";
import { assertEquals } from "@std/assert";

export interface GitFixture {
  readonly root: string;
  readonly remote: string;
  readonly worktree: string;
  readonly git: (args: readonly string[], cwd?: string) => Promise<string>;
  readonly commit: () => Promise<string>;
  readonly advance: (message?: string) => Promise<string>;
}

export async function createGitFixture(): Promise<GitFixture> {
  const root = await Deno.makeTempDir({ prefix: "source-ref-git-" });
  const remote = join(root, "remote.git");
  const worktree = join(root, "upstream-worktree");
  const isolatedConfig = join(root, "isolated.gitconfig");
  await Deno.writeTextFile(isolatedConfig, "");

  const git = async (args: readonly string[], cwd?: string): Promise<string> => {
    const output = await new Deno.Command("git", {
      args: [
        "-c",
        "user.name=source-ref tests",
        "-c",
        "user.email=source-ref-tests@example.invalid",
        ...args,
      ],
      cwd,
      env: {
        GIT_CONFIG_GLOBAL: isolatedConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(
        `git ${args.join(" ")} failed (${output.code}): ${new TextDecoder().decode(output.stderr)}`,
      );
    }
    return new TextDecoder().decode(output.stdout).trim();
  };

  await git(["init", "--bare", remote]);
  await git(["init", worktree]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], worktree);
  await Deno.writeTextFile(join(worktree, "fixture.txt"), "one\n");
  await git(["add", "--", "fixture.txt"], worktree);
  await git(["commit", "-m", "initial"], worktree);
  await git(["tag", "-a", "v1", "-m", "annotated v1"], worktree);
  await git(["tag", "lightweight"], worktree);
  await git(["remote", "add", "origin", remote], worktree);
  await git(["push", "-u", "origin", "main", "--tags"], worktree);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);

  let sequence = 1;
  const commit = () => git(["rev-parse", "HEAD"], worktree);
  const advance = async (message = "advance"): Promise<string> => {
    sequence++;
    await Deno.writeTextFile(join(worktree, "fixture.txt"), `${sequence}\n`);
    await git(["add", "--", "fixture.txt"], worktree);
    await git(["commit", "-m", `${message} ${sequence}`], worktree);
    await git(["push", "origin", "main"], worktree);
    return await commit();
  };

  return { root, remote, worktree, git, commit, advance };
}

export async function assertGitCommit(
  git: GitFixture["git"],
  checkout: string,
  expected: string,
): Promise<void> {
  assertEquals(await git(["rev-parse", "HEAD"], checkout), expected);
}

export async function cleanup(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}
