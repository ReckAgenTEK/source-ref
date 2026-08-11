/**
 * Deterministic, project-local Git checkouts backed by the installed Git executable.
 *
 * @example Manage a branch as an immutable local checkout.
 * ```ts
 * import { SourceRefStore } from "@mannsion/source-ref";
 *
 * const store = new SourceRefStore({ projectRoot: Deno.cwd() });
 * await store.ensure({
 *   id: { provider: "github", name: "source-ref" },
 *   url: "https://github.com/zignado/source-ref.git",
 *   mode: "pinned",
 *   ref: { kind: "branch", value: "main" },
 * });
 * ```
 *
 * @module
 */

export {
  CLI_JSON_SCHEMA_VERSION,
  LOCKFILE_SCHEMA_VERSION,
  MINIMUM_GIT_VERSION,
  SOURCE_REF_SCHEMA_VERSION,
  SOURCE_REF_VERSION,
  STATE_SCHEMA_VERSION,
} from "./constants.ts";
export {
  BranchModeRequiredError,
  DirtyWorktreeError,
  GitCommandError,
  GitNotFoundError,
  GitOutputTruncatedError,
  GitVersionUnsupportedError,
  InvalidArgumentError,
  InvalidGitRefError,
  InvalidManagedRepositoryError,
  InvalidRepositoryIdError,
  InvalidRepositoryNameError,
  InvalidRepositoryUrlError,
  LockedCommitMismatchError,
  LockedRequestMismatchError,
  LockFileValidationError,
  OperationAbortedError,
  OperationLockedError,
  PathOutsideRootError,
  RepositoryIdCollisionError,
  RepositoryNotFoundError,
  SourceRefError,
  type SourceRefErrorCode,
  SourceRefIoError,
  StateFileValidationError,
} from "./errors.ts";
export { SourceRefStore } from "./source_ref_store.ts";
export type {
  AheadBehind,
  CheckoutMode,
  CheckoutOptions,
  CheckoutResult,
  DescribeRevisionOptions,
  DoctorResult,
  EnsureRequest,
  FetchOptions,
  FetchResult,
  GitDoctorStatus,
  GitRef,
  ListRemoteRefsRequest,
  ManagedRepository,
  PathOptions,
  PullOptions,
  RemoteHead,
  RemoteRef,
  RemoteRefKind,
  RepositoryId,
  RepositorySelector,
  RepositoryStatus,
  ResolveRemoteHeadRequest,
  RevisionDescription,
  SourceRefStoreOptions,
  StatusOptions,
  SyncOptions,
  UpdateOptions,
} from "./types.ts";
