import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { InvalidRepositoryUrlError, PathOutsideRootError } from "../src/errors.ts";
import {
  assertPathContained,
  createRepositoryLayout,
  createStoreLayout,
  validateRepositoryName,
} from "../src/layout.ts";
import { parseRepositoryUrl, redactUrl } from "../src/repository_url.ts";

Deno.test("repository URL forms derive stable identities", () => {
  const root = "/workspace/project";
  const cases = [
    ["https://github.com/owner/repo.git", "github", "repo", "remote:github.com/owner/repo"],
    ["ssh://git@codeberg.org/owner/repo.git", "codeberg", "repo", "remote:codeberg.org/owner/repo"],
    ["git@gitlab.com:owner/repo.git", "gitlab", "repo", "remote:gitlab.com/owner/repo"],
    ["git://bitbucket.org/owner/repo.git", "bitbucket", "repo", "remote:bitbucket.org/owner/repo"],
    [
      "git:git.example.com/owner/repo.git",
      "git-example-com",
      "repo",
      "remote:git.example.com/owner/repo",
    ],
  ] as const;
  for (const [url, provider, name, identity] of cases) {
    const parsed = parseRepositoryUrl(url, root);
    assertEquals(parsed.provider, provider);
    assertEquals(parsed.defaultName, name);
    assertEquals(parsed.identity, identity);
  }

  assertEquals(
    parseRepositoryUrl("https://github.com/owner/repo.git", root).identity,
    parseRepositoryUrl("git@github.com:owner/repo.git", root).identity,
  );
  assertNotEquals(
    parseRepositoryUrl("https://git.example.com:8443/a/repo", root).provider,
    parseRepositoryUrl("https://git.example.com/a/repo", root).provider,
  );
});

Deno.test("file URLs and local paths use absolute local identity", () => {
  const root = Deno.build.os === "windows" ? "C:\\project" : "/project";
  const local = parseRepositoryUrl("./fixtures/repo.git", root);
  assertEquals(local.provider, "local");
  assertEquals(local.defaultName, "repo");
  assertMatch(local.identity, /^local:/);

  const absolute = join(root, "fixtures", "repo.git");
  const file = parseRepositoryUrl(toFileUrl(absolute).href, root);
  assertEquals(file.identity, local.identity);
  assertEquals(file.provider, "local");
});

Deno.test("credential-bearing URLs are rejected and redacted", () => {
  const error = assertThrows(
    () => parseRepositoryUrl("https://alice:super-secret@github.com/o/r.git"),
    InvalidRepositoryUrlError,
  );
  assertEquals(error.code, "INVALID_REPOSITORY_URL");
  assertEquals(JSON.stringify(error.details).includes("super-secret"), false);
  const redacted = redactUrl("https://alice:super-secret@github.com/o/r.git");
  assertEquals(redacted.includes("super-secret"), false);
  assertStringIncludes(redacted, "redacted");
  assertThrows(
    () => parseRepositoryUrl("https://github.com/owner/repo%00.git"),
    InvalidRepositoryUrlError,
  );
});

Deno.test("portable names and containment reject traversal and reserved names", () => {
  for (const name of ["zig", "repo-1", "repo.name", "A_b"]) validateRepositoryName(name);
  for (const name of [".", "..", "a/b", "a\\b", "CON", "nul.txt", "bad name", "trail."]) {
    assertThrows(() => validateRepositoryName(name));
  }

  const layout = createStoreLayout({ projectRoot: "/tmp/project" });
  const repository = createRepositoryLayout(layout, { provider: "codeberg", name: "zig" });
  assertEquals(repository.checkoutPath, join(layout.root, "codeberg", "zig", "git-src"));
  assertThrows(
    () => assertPathContained(layout.root, join(layout.root, "..", "outside")),
    PathOutsideRootError,
  );
});
