# @reckagentek/source-ref

`source-ref` is a Deno 2 library and CLI for deterministic, project-local Git checkouts. It invokes
the installed `git` executable directly through `Deno.Command`; it never invokes a shell and has no
Node runtime path.

Git `2.20.0` or newer is required. Authentication is delegated to Git credential helpers and SSH
agents. Credential-bearing URLs are rejected.

## Install

Add the library to a Deno project:

```bash
deno add jsr:@reckagentek/source-ref@0.1.0-beta.2
```

Install the CLI globally:

```bash
deno install --global --name source-ref \
  --allow-read --allow-write --allow-run=git \
  jsr:@reckagentek/source-ref@0.1.0-beta.2/cli
```

## Library API

```ts
import { SourceRefStore } from "@reckagentek/source-ref";

const store = new SourceRefStore({
  projectRoot: Deno.cwd(),
  root: ".source-ref",
  lockFile: "source-ref.lock.json",
});

const repository = {
  id: { provider: "github", name: "source-ref" },
  url: "https://github.com/ReckAgenTEK/source-ref.git",
};

const checkout = await store.ensure({
  ...repository,
  mode: "pinned",
  ref: { kind: "branch", value: "main" },
});

const tags = await store.listRemoteRefs({
  url: repository.url,
  kind: "tag",
});

const remoteHead = await store.resolveRemoteHead({
  url: repository.url,
});

const revision = await store.describeRevision(repository.id, {
  tagPattern: "v*",
  abbreviationLength: 9,
});
```

`ensure()` creates a checkout or reproduces an existing lock. It will not advance an existing
request; use `update()` to resolve that request again or `checkout()` to select another explicit
ref.

Public methods:

- `ensure(request): Promise<CheckoutResult>`
- `listRemoteRefs({ url, kind?, signal? }): Promise<RemoteRef[]>`
- `resolveRemoteHead({ url, signal? }): Promise<RemoteHead>`
- `describeRevision(id, options?): Promise<RevisionDescription>`
- `fetch(id, { ref?, signal? }): Promise<FetchResult>`
- `sync(id?, { signal? }): Promise<CheckoutResult[]>`
- `update(id, { ref?, signal? }): Promise<CheckoutResult>`
- `checkout(id, ref, { mode?, signal? }): Promise<CheckoutResult>`
- `pull(id, { signal? }): Promise<CheckoutResult>`; branch mode only, always `--ff-only`
- `status(id?, { signal? }): Promise<RepositoryStatus[]>`
- `path(id, { repositoryRoot? }): string`
- `list(): Promise<ManagedRepository[]>`
- `doctor(signal?): Promise<DoctorResult>`

An ID argument can be `{ provider, name }` or a `"provider/name"` string. Remote refs are normalized
to `{ kind, name, commit }`; annotated tags contain the peeled commit. Remote HEAD resolves to
`{ branch, commit }`. Result paths are absolute. `CheckoutResult` also reports `cloned`, `fetched`,
and `checkoutChanged` so callers can describe performed work without accessing Git output.
`RevisionDescription` exposes the locked commit's nearest matching tag, commit distance, and
unambiguous abbreviated commit without exposing raw Git output.

Only domain types, constants, `SourceRefStore`, and typed public errors are exported from the
package root. Git command output, process execution, and filesystem-layout internals are private.

## Safety Model

- `.source-ref/<provider>/<name>/git-src` is generated checkout state.
- `source-ref.lock.json` schema v1 is the reproducible pin.
- Lock and state JSON are written through flushed temporary sibling files and atomic renames.
- Mutating operations use atomic repository-specific directories under `.source-ref/.locks`.
- Shared JSON updates use a short-lived atomic metadata lock so concurrent repositories cannot lose
  entries.
- A stale operation or metadata lock is never removed automatically; remove one explicitly only
  after inspecting its `owner.json` metadata.
- Dirty worktrees are never reset, cleaned, stashed, merged, or rebased.
- Pinned mode uses detached commits. Branch mode uses an upstream-tracking branch and only
  fast-forward transitions.
- A lock entry is changed only after Git and state persistence succeed.

## CLI

```text
deno run --allow-read --allow-write --allow-run=git jsr:@reckagentek/source-ref@0.1.0-beta.2/cli ensure https://github.com/ReckAgenTEK/source-ref.git --name source-ref --ref main --ref-kind branch --mode pinned
source-ref fetch <provider/name>
source-ref sync [provider/name]
source-ref update <provider/name> [--ref <ref> --ref-kind <kind>]
source-ref checkout <provider/name> --ref <ref> --ref-kind <kind>
source-ref pull <provider/name>
source-ref status [provider/name] [--json]
source-ref path <provider/name> [--repository-root]
source-ref list [--json]
source-ref doctor [--json]
```

`path` writes only its path value to stdout. Mutation progress is written to stderr. `--json`
success and error documents use `schemaVersion: 1` and stable typed error codes.

## Development

```text
deno task check
deno publish --dry-run --allow-dirty
```

Tests are network-independent and use temporary local Git repositories.

Publishing runs from [`.github/workflows/publish.yml`](./.github/workflows/publish.yml) when a
`v<version>` tag matching `deno.json` is pushed. JSR authenticates the linked GitHub repository with
OIDC, so no registry token is stored in GitHub.
