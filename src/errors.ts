export type SourceRefErrorCode =
  | "GIT_NOT_FOUND"
  | "GIT_VERSION_UNSUPPORTED"
  | "GIT_COMMAND_FAILED"
  | "GIT_OUTPUT_TRUNCATED"
  | "INVALID_REPOSITORY_URL"
  | "INVALID_REPOSITORY_NAME"
  | "INVALID_REPOSITORY_ID"
  | "INVALID_GIT_REF"
  | "REPOSITORY_ID_COLLISION"
  | "REPOSITORY_NOT_FOUND"
  | "INVALID_MANAGED_REPOSITORY"
  | "DIRTY_WORKTREE"
  | "LOCKED_COMMIT_MISMATCH"
  | "LOCKED_REQUEST_MISMATCH"
  | "OPERATION_LOCKED"
  | "OPERATION_ABORTED"
  | "INVALID_LOCK_FILE"
  | "INVALID_STATE_FILE"
  | "PATH_OUTSIDE_ROOT"
  | "BRANCH_MODE_REQUIRED"
  | "SOURCE_REF_IO"
  | "INVALID_ARGUMENT";

export class SourceRefError extends Error {
  readonly code: SourceRefErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: SourceRefErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class InvalidRepositoryUrlError extends SourceRefError {
  constructor(redactedUrl: string, reason: string, options?: ErrorOptions) {
    super(
      "INVALID_REPOSITORY_URL",
      `Invalid repository URL: ${reason}`,
      { url: redactedUrl, reason },
      options,
    );
  }
}

export class InvalidRepositoryNameError extends SourceRefError {
  constructor(name: string, reason: string) {
    super(
      "INVALID_REPOSITORY_NAME",
      `Invalid repository name '${name}': ${reason}`,
      { name, reason },
    );
  }
}

export class InvalidRepositoryIdError extends SourceRefError {
  constructor(provider: string, name: string, reason: string) {
    super(
      "INVALID_REPOSITORY_ID",
      `Invalid repository ID '${provider}/${name}': ${reason}`,
      { provider, name, reason },
    );
  }
}

export class InvalidGitRefError extends SourceRefError {
  constructor(kind: string, value: string, reason: string) {
    super(
      "INVALID_GIT_REF",
      `Invalid ${kind} ref '${value}': ${reason}`,
      { kind, value, reason },
    );
  }
}

export class GitNotFoundError extends SourceRefError {
  constructor(options?: ErrorOptions) {
    super(
      "GIT_NOT_FOUND",
      "Git executable was not found",
      { executable: "git" },
      options,
    );
  }
}

export class GitVersionUnsupportedError extends SourceRefError {
  constructor(version: string, minimumVersion: string) {
    super(
      "GIT_VERSION_UNSUPPORTED",
      `Git ${version} is unsupported; Git ${minimumVersion} or newer is required`,
      { version, minimumVersion },
    );
  }
}

export class GitCommandError extends SourceRefError {
  readonly exitCode: number;

  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> & { exitCode: number },
    options?: ErrorOptions,
  ) {
    super("GIT_COMMAND_FAILED", message, details, options);
    this.exitCode = details.exitCode;
  }
}

export class GitOutputTruncatedError extends SourceRefError {
  constructor(operation: string) {
    super(
      "GIT_OUTPUT_TRUNCATED",
      `Git output exceeded the safe capture limit during ${operation}`,
      { operation },
    );
  }
}

export class RepositoryIdCollisionError extends SourceRefError {
  constructor(
    key: string,
    existingUrl: string,
    requestedUrl: string,
    reason = "the repository ID is already assigned to a different URL",
  ) {
    super(
      "REPOSITORY_ID_COLLISION",
      `Repository ID '${key}' collides with a different repository`,
      { key, existingUrl, requestedUrl, reason },
    );
  }
}

export class RepositoryNotFoundError extends SourceRefError {
  constructor(key: string) {
    super(
      "REPOSITORY_NOT_FOUND",
      `Managed repository '${key}' was not found in the lock file`,
      { key },
    );
  }
}

export class InvalidManagedRepositoryError extends SourceRefError {
  constructor(path: string) {
    super(
      "INVALID_MANAGED_REPOSITORY",
      `Managed checkout path is not a Git worktree: ${path}`,
      { path },
    );
  }
}

export class DirtyWorktreeError extends SourceRefError {
  constructor(path: string, changes: readonly string[]) {
    super(
      "DIRTY_WORKTREE",
      `Managed checkout has local changes: ${path}`,
      { path, changes },
    );
  }
}

export class LockedCommitMismatchError extends SourceRefError {
  constructor(path: string, lockedCommit: string, currentCommit: string | null, reason?: string) {
    super(
      "LOCKED_COMMIT_MISMATCH",
      reason ?? `Checkout cannot be safely synchronized to locked commit ${lockedCommit}`,
      { path, lockedCommit, currentCommit },
    );
  }
}

export class LockedRequestMismatchError extends SourceRefError {
  constructor(key: string) {
    super(
      "LOCKED_REQUEST_MISMATCH",
      `Ensure request for '${key}' differs from its lock; use checkout or update explicitly`,
      { key },
    );
  }
}

export class OperationLockedError extends SourceRefError {
  constructor(key: string, lockPath: string, owner: unknown) {
    super(
      "OPERATION_LOCKED",
      `Another operation holds the lock for '${key}'`,
      { key, lockPath, owner },
    );
  }
}

export class OperationAbortedError extends SourceRefError {
  constructor(operation: string, options?: ErrorOptions) {
    super(
      "OPERATION_ABORTED",
      `Operation was aborted: ${operation}`,
      { operation },
      options,
    );
  }
}

export class LockFileValidationError extends SourceRefError {
  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(
      "INVALID_LOCK_FILE",
      `Invalid source-ref lock file '${path}': ${reason}`,
      { path, reason },
      options,
    );
  }
}

export class StateFileValidationError extends SourceRefError {
  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(
      "INVALID_STATE_FILE",
      `Invalid source-ref state file '${path}': ${reason}`,
      { path, reason },
      options,
    );
  }
}

export class PathOutsideRootError extends SourceRefError {
  constructor(root: string, candidate: string) {
    super(
      "PATH_OUTSIDE_ROOT",
      "Derived repository path escapes the managed root",
      { root, candidate },
    );
  }
}

export class BranchModeRequiredError extends SourceRefError {
  constructor(key: string, reason: string) {
    super(
      "BRANCH_MODE_REQUIRED",
      `Repository '${key}' is not available as an upstream-tracking branch: ${reason}`,
      { key, reason },
    );
  }
}

export class SourceRefIoError extends SourceRefError {
  constructor(action: string, path: string, options?: ErrorOptions) {
    super(
      "SOURCE_REF_IO",
      `Failed to ${action}: ${path}`,
      { action, path },
      options,
    );
  }
}

export class InvalidArgumentError extends SourceRefError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("INVALID_ARGUMENT", message, details);
  }
}
