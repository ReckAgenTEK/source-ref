import { MINIMUM_GIT_VERSION, SOURCE_REF_SCHEMA_VERSION } from "./constants.ts";
import {
  BranchModeRequiredError,
  DirtyWorktreeError,
  InvalidManagedRepositoryError,
  InvalidRepositoryIdError,
  LockedCommitMismatchError,
  LockedRequestMismatchError,
  LockFileValidationError,
  OperationAbortedError,
  RepositoryIdCollisionError,
  RepositoryNotFoundError,
  SourceRefIoError,
} from "./errors.ts";
import { compareVersions, GitClient } from "./git_client.ts";
import {
  createRepositoryLayout,
  createStoreLayout,
  parseRepositoryKey,
  parseRepositorySelector,
  repositoryKey,
  type RepositoryLayout,
  type StoreLayout,
  validateRepositoryId,
} from "./layout.ts";
import { type LockEntry, readLockFile, type SourceRefLockFile, writeLockFile } from "./lockfile.ts";
import { MetadataLock, OperationLock } from "./operation_lock.ts";
import { type ParsedRepositoryUrl, parseRepositoryUrl, redactUrl } from "./repository_url.ts";
import {
  readStateFile,
  type SourceRefStateFile,
  type StateEntry,
  writeStateFile,
} from "./state.ts";
import type {
  CheckoutMode,
  CheckoutOptions,
  CheckoutResult,
  DescribeRevisionOptions,
  DoctorResult,
  EnsureRequest,
  FetchOptions,
  FetchResult,
  GitRef,
  ListRemoteRefsRequest,
  ManagedRepository,
  PathOptions,
  PullOptions,
  RemoteRef,
  RepositoryId,
  RepositorySelector,
  RepositoryStatus,
  RevisionDescription,
  SourceRefStoreOptions,
  StatusOptions,
  SyncOptions,
  UpdateOptions,
} from "./types.ts";

interface CheckoutAvailability {
  readonly cloned: boolean;
  readonly paths: RepositoryLayout;
}

interface MutationResult {
  readonly fetched: boolean;
  readonly checkoutChanged: boolean;
  readonly resolvedCommit: string;
}

export class SourceRefStore {
  readonly #layout: StoreLayout;
  readonly #git: GitClient;

  constructor(options?: SourceRefStoreOptions);
  constructor(options: SourceRefStoreOptions = {}, gitClient = new GitClient()) {
    this.#layout = createStoreLayout(options);
    this.#git = gitClient;
  }

  get projectRoot(): string {
    return this.#layout.projectRoot;
  }

  get root(): string {
    return this.#layout.root;
  }

  get lockFile(): string {
    return this.#layout.lockFile;
  }

  async ensure(request: EnsureRequest): Promise<CheckoutResult> {
    const parsed = this.#parseRequestUrl(request.id, request.url);
    this.#assertModeRef(request.mode, request.ref, request.id);
    await this.#git.assertSupportedVersion(request.signal);
    await this.#git.validateRef(request.ref, request.signal);

    return await this.#withOperation(request.id, "ensure", async (operationId) => {
      const key = repositoryKey(request.id);
      const lock = await this.#readLock();
      const existing = lock.repositories[key];
      if (existing) {
        this.#assertSameIdentity(key, existing.url, parsed.url);
        if (existing.mode !== request.mode || !refsEqual(existing.requested, request.ref)) {
          throw new LockedRequestMismatchError(key);
        }
        const checkout = await this.#ensureCheckout(request.id, existing.url, request.signal);
        const mutation = await this.#syncEntry(existing, checkout, request.signal);
        await this.#recordState(
          request.id,
          existing.url,
          mutation.fetched || checkout.cloned,
          "ensure",
          request.signal,
        );
        return this.#checkoutResult(
          operationId,
          request.id,
          existing,
          checkout,
          mutation.fetched,
          mutation.checkoutChanged,
        );
      }

      await this.#assertStateIdentity(request.id, parsed);
      const checkout = await this.#ensureCheckout(request.id, parsed.url, request.signal);
      const mutation = await this.#resolveAndCheckout(
        request.id,
        checkout,
        request.mode,
        request.ref,
        request.signal,
      );
      const entry: LockEntry = {
        url: parsed.url,
        mode: request.mode,
        requested: cloneRef(request.ref),
        resolvedCommit: mutation.resolvedCommit,
      };
      await this.#recordState(request.id, parsed.url, true, "ensure", request.signal);
      await this.#writeLockEntry(request.id, entry, request.signal);
      return this.#checkoutResult(
        operationId,
        request.id,
        entry,
        checkout,
        mutation.fetched,
        mutation.checkoutChanged,
      );
    }, request.signal);
  }

  async listRemoteRefs(request: ListRemoteRefsRequest): Promise<RemoteRef[]> {
    const parsed = parseRepositoryUrl(request.url, this.#layout.projectRoot);
    await this.#git.assertSupportedVersion(request.signal);
    return await this.#git.listRemoteRefs(parsed.url, request.kind, request.signal);
  }

  async describeRevision(
    selector: RepositorySelector,
    options: DescribeRevisionOptions = {},
  ): Promise<RevisionDescription> {
    const id = parseRepositorySelector(selector);
    await this.#git.assertSupportedVersion(options.signal);
    const entry = await this.#requiredEntry(id);
    const paths = createRepositoryLayout(this.#layout, id);
    if (
      !await pathExists(paths.checkoutPath) ||
      !await this.#git.isRepository(paths.checkoutPath, options.signal) ||
      !await this.#git.hasCommit(paths.checkoutPath, entry.resolvedCommit, options.signal)
    ) {
      throw new LockedCommitMismatchError(
        paths.checkoutPath,
        entry.resolvedCommit,
        null,
        "Locked commit is unavailable for revision description",
      );
    }
    return await this.#git.describeRevision(
      paths.checkoutPath,
      entry.resolvedCommit,
      options.tagPattern,
      options.abbreviationLength,
      options.signal,
    );
  }

  async fetch(selector: RepositorySelector, options: FetchOptions = {}): Promise<FetchResult> {
    const id = parseRepositorySelector(selector);
    await this.#git.assertSupportedVersion(options.signal);
    return await this.#withOperation(id, "fetch", async (operationId) => {
      const entry = await this.#requiredEntry(id);
      const requested = options.ref ?? entry.requested;
      await this.#git.validateRef(requested, options.signal);
      const checkout = await this.#ensureCheckout(id, entry.url, options.signal);
      await this.#git.fetchRef(checkout.paths.checkoutPath, requested, options.signal);
      await this.#recordState(id, entry.url, true, "fetch", options.signal);
      return {
        operationId,
        id,
        checkoutPath: checkout.paths.checkoutPath,
        requested: cloneRef(requested),
        cloned: checkout.cloned,
        fetched: true,
      };
    }, options.signal);
  }

  async sync(
    selector?: RepositorySelector,
    options: SyncOptions = {},
  ): Promise<CheckoutResult[]> {
    await this.#git.assertSupportedVersion(options.signal);
    const ids = selector === undefined
      ? Object.keys((await this.#readLock()).repositories).sort().map(parseRepositoryKey)
      : [parseRepositorySelector(selector)];
    const results: CheckoutResult[] = [];
    for (const id of ids) {
      results.push(
        await this.#withOperation(id, "sync", async (operationId) => {
          const entry = await this.#requiredEntry(id);
          const checkout = await this.#ensureCheckout(id, entry.url, options.signal);
          const mutation = await this.#syncEntry(entry, checkout, options.signal);
          await this.#recordState(
            id,
            entry.url,
            mutation.fetched || checkout.cloned,
            "sync",
            options.signal,
          );
          return this.#checkoutResult(
            operationId,
            id,
            entry,
            checkout,
            mutation.fetched,
            mutation.checkoutChanged,
          );
        }, options.signal),
      );
    }
    return results;
  }

  async update(selector: RepositorySelector, options: UpdateOptions = {}): Promise<CheckoutResult> {
    const id = parseRepositorySelector(selector);
    await this.#git.assertSupportedVersion(options.signal);
    return await this.#withOperation(id, "update", async (operationId) => {
      const existing = await this.#requiredEntry(id);
      const requested = options.ref ?? existing.requested;
      this.#assertModeRef(existing.mode, requested, id);
      await this.#git.validateRef(requested, options.signal);
      const checkout = await this.#ensureCheckout(id, existing.url, options.signal);
      const mutation = await this.#resolveAndCheckout(
        id,
        checkout,
        existing.mode,
        requested,
        options.signal,
      );
      const entry: LockEntry = {
        ...existing,
        requested: cloneRef(requested),
        resolvedCommit: mutation.resolvedCommit,
      };
      await this.#recordState(id, entry.url, true, "update", options.signal);
      await this.#writeLockEntry(id, entry, options.signal);
      return this.#checkoutResult(
        operationId,
        id,
        entry,
        checkout,
        mutation.fetched,
        mutation.checkoutChanged,
      );
    }, options.signal);
  }

  async checkout(
    selector: RepositorySelector,
    ref: GitRef,
    options: CheckoutOptions = {},
  ): Promise<CheckoutResult> {
    const id = parseRepositorySelector(selector);
    await this.#git.assertSupportedVersion(options.signal);
    return await this.#withOperation(id, "checkout", async (operationId) => {
      const existing = await this.#requiredEntry(id);
      const mode = options.mode ?? existing.mode;
      this.#assertModeRef(mode, ref, id);
      await this.#git.validateRef(ref, options.signal);
      const checkout = await this.#ensureCheckout(id, existing.url, options.signal);
      const mutation = await this.#resolveAndCheckout(id, checkout, mode, ref, options.signal);
      const entry: LockEntry = {
        ...existing,
        mode,
        requested: cloneRef(ref),
        resolvedCommit: mutation.resolvedCommit,
      };
      await this.#recordState(id, entry.url, true, "checkout", options.signal);
      await this.#writeLockEntry(id, entry, options.signal);
      return this.#checkoutResult(
        operationId,
        id,
        entry,
        checkout,
        mutation.fetched,
        mutation.checkoutChanged,
      );
    }, options.signal);
  }

  async pull(selector: RepositorySelector, options: PullOptions = {}): Promise<CheckoutResult> {
    const id = parseRepositorySelector(selector);
    await this.#git.assertSupportedVersion(options.signal);
    return await this.#withOperation(id, "pull", async (operationId) => {
      const existing = await this.#requiredEntry(id);
      if (existing.mode !== "branch" || existing.requested.kind !== "branch") {
        throw new BranchModeRequiredError(repositoryKey(id), "pull is valid only in branch mode");
      }
      const checkout = await this.#ensureCheckout(id, existing.url, options.signal);
      let checkoutChanged = false;
      if (checkout.cloned) {
        checkoutChanged =
          (await this.#syncEntry(existing, checkout, options.signal)).checkoutChanged;
      } else {
        const localCommit = await this.#git.localBranchCommit(
          checkout.paths.checkoutPath,
          existing.requested.value,
          options.signal,
        );
        if (localCommit === null) {
          checkoutChanged = (await this.#syncEntry(existing, checkout, options.signal))
            .checkoutChanged;
        } else if (
          await this.#git.currentBranch(checkout.paths.checkoutPath, options.signal) !==
            existing.requested.value
        ) {
          await this.#assertClean(checkout.paths.checkoutPath, options.signal);
          await this.#git.checkoutBranch(
            checkout.paths.checkoutPath,
            existing.requested.value,
            options.signal,
          );
          checkoutChanged = true;
        }
        await this.#git.setUpstream(
          checkout.paths.checkoutPath,
          existing.requested.value,
          options.signal,
        );
      }
      await this.#assertClean(checkout.paths.checkoutPath, options.signal);
      await this.#git.pullFastForwardOnly(checkout.paths.checkoutPath, options.signal);
      const resolvedCommit = await this.#git.currentCommit(
        checkout.paths.checkoutPath,
        options.signal,
      );
      if (!resolvedCommit) {
        throw new LockedCommitMismatchError(
          checkout.paths.checkoutPath,
          existing.resolvedCommit,
          null,
          "Branch pull completed without a current commit",
        );
      }
      const entry: LockEntry = { ...existing, resolvedCommit };
      await this.#recordState(id, entry.url, true, "pull", options.signal);
      await this.#writeLockEntry(id, entry, options.signal);
      return this.#checkoutResult(
        operationId,
        id,
        entry,
        checkout,
        true,
        checkoutChanged || resolvedCommit !== existing.resolvedCommit,
      );
    }, options.signal);
  }

  path(selector: RepositorySelector, options: PathOptions = {}): string {
    const id = parseRepositorySelector(selector);
    const paths = createRepositoryLayout(this.#layout, id);
    return options.repositoryRoot ? paths.repositoryHome : paths.checkoutPath;
  }

  async list(): Promise<ManagedRepository[]> {
    const [lock, state] = await Promise.all([
      this.#readLock(),
      readStateFile(this.#layout.stateFile),
    ]);
    return Object.entries(lock.repositories).sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) => {
          const id = parseRepositoryKey(key);
          const paths = createRepositoryLayout(this.#layout, id);
          const stateEntry = state.repositories[key];
          return {
            id,
            key,
            repositoryHome: paths.repositoryHome,
            checkoutPath: paths.checkoutPath,
            url: entry.url,
            mode: entry.mode,
            requested: cloneRef(entry.requested),
            resolvedCommit: entry.resolvedCommit,
            lastFetchAt: stateEntry?.lastFetchAt ?? null,
            lastOperationAt: stateEntry?.lastOperationAt ?? null,
          };
        },
      );
  }

  async status(
    selector?: RepositorySelector,
    options: StatusOptions = {},
  ): Promise<RepositoryStatus[]> {
    const lock = await this.#readLock();
    const entries = selector === undefined
      ? Object.entries(lock.repositories).sort(([left], [right]) => left.localeCompare(right))
      : [
        [
          repositoryKey(parseRepositorySelector(selector)),
          await this.#requiredEntry(parseRepositorySelector(selector)),
        ] as const,
      ];
    const statuses: RepositoryStatus[] = [];
    for (const [key, entry] of entries) {
      if (options.signal?.aborted) throw new OperationAbortedError("status");
      const id = parseRepositoryKey(key);
      const paths = createRepositoryLayout(this.#layout, id);
      const checkoutExists = await pathExists(paths.checkoutPath);
      if (!checkoutExists) {
        statuses.push({
          id,
          repositoryHome: paths.repositoryHome,
          checkoutPath: paths.checkoutPath,
          url: entry.url,
          mode: entry.mode,
          requested: cloneRef(entry.requested),
          lockedCommit: entry.resolvedCommit,
          checkoutExists: false,
          currentCommit: null,
          currentBranch: null,
          dirty: null,
          changes: [],
          aheadBehind: null,
          matchesLock: false,
        });
        continue;
      }
      if (!await this.#git.isRepository(paths.checkoutPath, options.signal)) {
        throw new InvalidManagedRepositoryError(paths.checkoutPath);
      }
      const [currentCommit, currentBranch, worktree] = await Promise.all([
        this.#git.currentCommit(paths.checkoutPath, options.signal),
        this.#git.currentBranch(paths.checkoutPath, options.signal),
        this.#git.worktreeStatus(paths.checkoutPath, options.signal),
      ]);
      const aheadBehind = entry.mode === "branch"
        ? await this.#git.aheadBehind(paths.checkoutPath, options.signal)
        : null;
      statuses.push({
        id,
        repositoryHome: paths.repositoryHome,
        checkoutPath: paths.checkoutPath,
        url: entry.url,
        mode: entry.mode,
        requested: cloneRef(entry.requested),
        lockedCommit: entry.resolvedCommit,
        checkoutExists: true,
        currentCommit,
        currentBranch,
        dirty: worktree.dirty,
        changes: worktree.changes,
        aheadBehind,
        matchesLock: currentCommit === entry.resolvedCommit,
      });
    }
    return statuses;
  }

  async doctor(signal?: AbortSignal): Promise<DoctorResult> {
    let version: string | null = null;
    let available = false;
    let supported = false;
    let message: string | null = null;
    try {
      version = await this.#git.version(signal);
      available = true;
      supported = compareVersions(version, MINIMUM_GIT_VERSION) >= 0;
      if (!supported) message = `Git ${MINIMUM_GIT_VERSION} or newer is required`;
    } catch (cause) {
      if (cause instanceof OperationAbortedError) throw cause;
      message = cause instanceof Error ? cause.message : String(cause);
    }
    return {
      schemaVersion: SOURCE_REF_SCHEMA_VERSION,
      ok: available && supported,
      git: { available, version, minimumVersion: MINIMUM_GIT_VERSION, supported, message },
      projectRoot: this.#layout.projectRoot,
      root: this.#layout.root,
      lockFile: this.#layout.lockFile,
    };
  }

  async #withOperation<T>(
    id: RepositoryId,
    operation: string,
    callback: (operationId: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new OperationAbortedError(operation);
    const paths = createRepositoryLayout(this.#layout, id);
    const lock = await OperationLock.acquire(id, paths, operation);
    try {
      return await callback(lock.operationId);
    } finally {
      await lock.release();
    }
  }

  async #ensureCheckout(
    id: RepositoryId,
    url: string,
    signal?: AbortSignal,
  ): Promise<CheckoutAvailability> {
    const paths = createRepositoryLayout(this.#layout, id);
    if (await pathExists(paths.checkoutPath)) {
      if (!await this.#git.isRepository(paths.checkoutPath, signal)) {
        throw new InvalidManagedRepositoryError(paths.checkoutPath);
      }
      await this.#assertRemoteIdentity(id, paths.checkoutPath, url, signal);
      return { cloned: false, paths };
    }

    try {
      await Deno.mkdir(paths.repositoryHome, { recursive: true });
    } catch (cause) {
      throw new SourceRefIoError("create repository home", paths.repositoryHome, { cause });
    }
    const temporary = `${paths.checkoutPath}.tmp-${crypto.randomUUID()}`;
    try {
      await this.#git.clone(url, temporary, signal);
      if (!await this.#git.isRepository(temporary, signal)) {
        throw new InvalidManagedRepositoryError(temporary);
      }
      await Deno.rename(temporary, paths.checkoutPath);
    } catch (cause) {
      try {
        await Deno.remove(temporary, { recursive: true });
      } catch (cleanupCause) {
        if (!(cleanupCause instanceof Deno.errors.NotFound)) {
          // Preserve the clone or rename failure.
        }
      }
      throw cause;
    }
    await this.#assertRemoteIdentity(id, paths.checkoutPath, url, signal);
    return { cloned: true, paths };
  }

  async #assertRemoteIdentity(
    id: RepositoryId,
    checkoutPath: string,
    expectedUrl: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const actualUrl = await this.#git.remoteUrl(checkoutPath, signal);
    const expected = parseRepositoryUrl(expectedUrl, this.#layout.projectRoot);
    const actual = parseRepositoryUrl(actualUrl, this.#layout.projectRoot);
    if (expected.identity !== actual.identity) {
      throw new RepositoryIdCollisionError(
        repositoryKey(id),
        redactUrl(actual.url),
        redactUrl(expected.url),
        "the checkout's origin remote has a different repository identity",
      );
    }
  }

  async #syncEntry(
    entry: LockEntry,
    checkout: CheckoutAvailability,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    let fetched = false;
    if (!await this.#git.hasCommit(checkout.paths.checkoutPath, entry.resolvedCommit, signal)) {
      await this.#git.fetchCommit(checkout.paths.checkoutPath, entry.resolvedCommit, signal);
      fetched = true;
    }
    const checkoutChanged = entry.mode === "pinned"
      ? await this.#checkoutPinned(
        checkout.paths.checkoutPath,
        entry.resolvedCommit,
        checkout.cloned,
        signal,
      )
      : await this.#checkoutBranchAt(
        checkout.paths.checkoutPath,
        entry.requested,
        entry.resolvedCommit,
        checkout.cloned,
        signal,
      );
    return { fetched, checkoutChanged, resolvedCommit: entry.resolvedCommit };
  }

  async #resolveAndCheckout(
    id: RepositoryId,
    checkout: CheckoutAvailability,
    mode: CheckoutMode,
    ref: GitRef,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    await this.#git.fetchRef(checkout.paths.checkoutPath, ref, signal);
    const resolvedCommit = await this.#git.resolveLocalRef(
      checkout.paths.checkoutPath,
      ref,
      signal,
    );
    const checkoutChanged = mode === "pinned"
      ? await this.#checkoutPinned(
        checkout.paths.checkoutPath,
        resolvedCommit,
        checkout.cloned,
        signal,
      )
      : await this.#checkoutBranchAt(
        checkout.paths.checkoutPath,
        ref,
        resolvedCommit,
        checkout.cloned,
        signal,
      );
    if (mode === "branch") {
      const current = await this.#git.currentCommit(checkout.paths.checkoutPath, signal);
      if (current !== resolvedCommit) {
        throw new LockedCommitMismatchError(
          checkout.paths.checkoutPath,
          resolvedCommit,
          current,
          `Branch '${repositoryKey(id)}' cannot be moved to the remote commit by fast-forward`,
        );
      }
    }
    return { fetched: true, checkoutChanged, resolvedCommit };
  }

  async #checkoutPinned(
    path: string,
    commit: string,
    freshClone: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const current = await this.#git.currentCommit(path, signal);
    const branch = await this.#git.currentBranch(path, signal);
    if (current === commit && branch === null) return false;
    if (!freshClone) await this.#assertClean(path, signal);
    await this.#git.checkoutDetached(path, commit, signal);
    const resulting = await this.#git.currentCommit(path, signal);
    if (resulting !== commit) throw new LockedCommitMismatchError(path, commit, resulting);
    return true;
  }

  async #checkoutBranchAt(
    path: string,
    ref: GitRef,
    commit: string,
    freshClone: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (ref.kind !== "branch") {
      throw new BranchModeRequiredError("unknown", "branch mode requires a branch ref");
    }
    const localCommit = await this.#git.localBranchCommit(path, ref.value, signal);
    if (
      !freshClone && localCommit !== null && localCommit !== commit &&
      !await this.#git.isAncestor(path, localCommit, commit, signal)
    ) {
      throw new LockedCommitMismatchError(
        path,
        commit,
        localCommit,
        `Local branch '${ref.value}' cannot be moved to the target commit by fast-forward`,
      );
    }
    const currentBranch = await this.#git.currentBranch(path, signal);
    let changed = false;
    if (localCommit === null || currentBranch !== ref.value || localCommit !== commit) {
      if (!freshClone) await this.#assertClean(path, signal);
      if (freshClone && localCommit !== null && localCommit !== commit) {
        await this.#git.recreateBranch(path, ref.value, commit, signal);
      } else if (localCommit === null) {
        await this.#git.createBranch(path, ref.value, commit, signal);
      } else {
        if (currentBranch !== ref.value) await this.#git.checkoutBranch(path, ref.value, signal);
        if (localCommit !== commit) await this.#git.fastForwardTo(path, commit, signal);
      }
      changed = true;
    }
    await this.#git.setUpstream(path, ref.value, signal);
    const resulting = await this.#git.currentCommit(path, signal);
    if (resulting !== commit) throw new LockedCommitMismatchError(path, commit, resulting);
    return changed;
  }

  async #assertClean(path: string, signal?: AbortSignal): Promise<void> {
    const status = await this.#git.worktreeStatus(path, signal);
    if (status.dirty) {
      const changes = status.truncated
        ? [...status.changes, "... output truncated ..."]
        : status.changes;
      throw new DirtyWorktreeError(path, changes);
    }
  }

  async #requiredEntry(id: RepositoryId): Promise<LockEntry> {
    const key = repositoryKey(id);
    const entry = (await this.#readLock()).repositories[key];
    if (!entry) throw new RepositoryNotFoundError(key);
    return entry;
  }

  async #assertStateIdentity(id: RepositoryId, requested: ParsedRepositoryUrl): Promise<void> {
    const key = repositoryKey(id);
    const state = await readStateFile(this.#layout.stateFile);
    const existing = state.repositories[key];
    if (existing && existing.identity !== requested.identity) {
      throw new RepositoryIdCollisionError(
        key,
        redactUrl(existing.url),
        redactUrl(requested.url),
        "generated state assigns the repository ID to a different URL",
      );
    }
  }

  async #readLock(): Promise<SourceRefLockFile> {
    const lock = await readLockFile(this.#layout.lockFile);
    for (const [key, entry] of Object.entries(lock.repositories)) {
      let parsed: ParsedRepositoryUrl;
      try {
        parsed = parseRepositoryUrl(entry.url, this.#layout.projectRoot);
      } catch (cause) {
        throw new LockFileValidationError(
          this.#layout.lockFile,
          `entry '${key}' contains an invalid or credential-bearing URL`,
          { cause },
        );
      }
      const id = parseRepositoryKey(key);
      if (parsed.provider !== id.provider) {
        throw new LockFileValidationError(
          this.#layout.lockFile,
          `entry '${key}' does not match URL provider '${parsed.provider}'`,
        );
      }
    }
    return lock;
  }

  async #writeLockEntry(
    id: RepositoryId,
    entry: LockEntry,
    signal?: AbortSignal,
  ): Promise<void> {
    const metadataLock = await MetadataLock.acquire(
      this.#layout.locksRoot,
      "write lock file",
      signal,
    );
    try {
      const key = repositoryKey(id);
      const lock = await this.#readLock();
      const existing = lock.repositories[key];
      if (existing) this.#assertSameIdentity(key, existing.url, entry.url);
      lock.repositories[key] = entry;
      await writeLockFile(this.#layout.lockFile, lock);
    } finally {
      await metadataLock.release();
    }
  }

  async #recordState(
    id: RepositoryId,
    url: string,
    fetched: boolean,
    operation: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const metadataLock = await MetadataLock.acquire(
      this.#layout.locksRoot,
      `write state after ${operation}`,
      signal,
    );
    try {
      const key = repositoryKey(id);
      const parsed = parseRepositoryUrl(url, this.#layout.projectRoot);
      const paths = createRepositoryLayout(this.#layout, id);
      const state: SourceRefStateFile = await readStateFile(this.#layout.stateFile);
      const previous = state.repositories[key];
      const now = new Date().toISOString();
      const entry: StateEntry = {
        url: parsed.url,
        identity: parsed.identity,
        repositoryHome: paths.repositoryHome,
        checkoutPath: paths.checkoutPath,
        lastOperationAt: now,
        ...(fetched
          ? { lastFetchAt: now }
          : previous?.lastFetchAt
          ? { lastFetchAt: previous.lastFetchAt }
          : {}),
      };
      state.repositories[key] = entry;
      await writeStateFile(this.#layout.stateFile, state);
    } finally {
      await metadataLock.release();
    }
  }

  #parseRequestUrl(id: RepositoryId, url: string): ParsedRepositoryUrl {
    validateRepositoryId(id);
    const parsed = parseRepositoryUrl(url, this.#layout.projectRoot);
    if (parsed.provider !== id.provider) {
      throw new InvalidRepositoryIdError(
        id.provider,
        id.name,
        `provider must be '${parsed.provider}' for this URL`,
      );
    }
    return parsed;
  }

  #assertSameIdentity(key: string, existingUrl: string, requestedUrl: string): void {
    const existing = parseRepositoryUrl(existingUrl, this.#layout.projectRoot);
    const requested = parseRepositoryUrl(requestedUrl, this.#layout.projectRoot);
    if (existing.identity !== requested.identity) {
      throw new RepositoryIdCollisionError(
        key,
        redactUrl(existing.url),
        redactUrl(requested.url),
      );
    }
  }

  #assertModeRef(mode: CheckoutMode, ref: GitRef, id: RepositoryId): void {
    if (mode === "branch" && ref.kind !== "branch") {
      throw new BranchModeRequiredError(repositoryKey(id), "branch mode requires a branch ref");
    }
  }

  #checkoutResult(
    operationId: string,
    id: RepositoryId,
    entry: LockEntry,
    checkout: CheckoutAvailability,
    fetched: boolean,
    checkoutChanged: boolean,
  ): CheckoutResult {
    return {
      operationId,
      id: { ...id },
      repositoryHome: checkout.paths.repositoryHome,
      checkoutPath: checkout.paths.checkoutPath,
      url: entry.url,
      mode: entry.mode,
      requested: cloneRef(entry.requested),
      resolvedCommit: entry.resolvedCommit,
      cloned: checkout.cloned,
      fetched: fetched || checkout.cloned,
      checkoutChanged,
    };
  }
}

function refsEqual(left: GitRef, right: GitRef): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function cloneRef(ref: GitRef): GitRef {
  return { kind: ref.kind, value: ref.value } as GitRef;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw new SourceRefIoError("inspect path", path, { cause });
  }
}
