export interface RepositoryId {
  readonly provider: string;
  readonly name: string;
}

export type RepositorySelector = RepositoryId | string;

export type GitRef =
  | { readonly kind: "tag"; readonly value: string }
  | { readonly kind: "branch"; readonly value: string }
  | { readonly kind: "commit"; readonly value: string };

export type CheckoutMode = "pinned" | "branch";
export type RemoteRefKind = "tag" | "branch";

export interface RemoteRef {
  readonly kind: RemoteRefKind;
  readonly name: string;
  readonly commit: string;
}

export interface RemoteHead {
  readonly branch: string;
  readonly commit: string;
}

export interface SourceRefStoreOptions {
  /** Base directory for relative root and lock-file paths. Defaults to Deno.cwd(). */
  readonly projectRoot?: string;
  /** Managed data root. Defaults to .source-ref under projectRoot. */
  readonly root?: string;
  /** Tracked lock file. Defaults to source-ref.lock.json under projectRoot. */
  readonly lockFile?: string;
  /** Optional observer for live Git network progress. The store never writes process streams. */
  readonly onProgress?: (text: string) => void | Promise<void>;
}

export interface EnsureRequest {
  readonly id: RepositoryId;
  readonly url: string;
  readonly mode: CheckoutMode;
  readonly ref: GitRef;
  readonly signal?: AbortSignal;
}

export interface ListRemoteRefsRequest {
  readonly url: string;
  readonly kind?: RemoteRefKind;
  readonly signal?: AbortSignal;
}

export interface ResolveRemoteHeadRequest {
  readonly url: string;
  readonly signal?: AbortSignal;
}

export interface DescribeRevisionOptions {
  /** Git tag-match pattern used to select the nearest tagged ancestor. Defaults to `*`. */
  readonly tagPattern?: string;
  /** Minimum hexadecimal commit abbreviation length. Defaults to 12. */
  readonly abbreviationLength?: number;
  readonly signal?: AbortSignal;
}

export interface RevisionDescription {
  readonly commit: string;
  readonly tag: string | null;
  readonly commitsSinceTag: number | null;
  readonly abbreviatedCommit: string;
}

export interface FetchOptions {
  readonly ref?: GitRef;
  readonly signal?: AbortSignal;
}

export interface SyncOptions {
  readonly signal?: AbortSignal;
}

export interface UpdateOptions {
  readonly ref?: GitRef;
  readonly signal?: AbortSignal;
}

export interface CheckoutOptions {
  /** Defaults to the repository's current mode. */
  readonly mode?: CheckoutMode;
  readonly signal?: AbortSignal;
}

export interface PullOptions {
  readonly signal?: AbortSignal;
}

export interface PathOptions {
  /** Return the repository home instead of its git-src checkout. */
  readonly repositoryRoot?: boolean;
}

export interface StatusOptions {
  readonly signal?: AbortSignal;
}

export interface CheckoutResult {
  readonly operationId: string;
  readonly id: RepositoryId;
  readonly repositoryHome: string;
  readonly checkoutPath: string;
  readonly url: string;
  readonly mode: CheckoutMode;
  readonly requested: GitRef;
  readonly resolvedCommit: string;
  readonly cloned: boolean;
  readonly fetched: boolean;
  readonly checkoutChanged: boolean;
}

export interface FetchResult {
  readonly operationId: string;
  readonly id: RepositoryId;
  readonly checkoutPath: string;
  readonly requested: GitRef;
  readonly cloned: boolean;
  readonly fetched: true;
}

export interface AheadBehind {
  readonly ahead: number;
  readonly behind: number;
}

export interface RepositoryStatus {
  readonly id: RepositoryId;
  readonly repositoryHome: string;
  readonly checkoutPath: string;
  readonly url: string;
  readonly mode: CheckoutMode;
  readonly requested: GitRef;
  readonly lockedCommit: string;
  readonly checkoutExists: boolean;
  readonly currentCommit: string | null;
  readonly currentBranch: string | null;
  readonly dirty: boolean | null;
  readonly changes: readonly string[];
  readonly aheadBehind: AheadBehind | null;
  readonly matchesLock: boolean;
}

export interface ManagedRepository {
  readonly id: RepositoryId;
  readonly key: string;
  readonly repositoryHome: string;
  readonly checkoutPath: string;
  readonly url: string;
  readonly mode: CheckoutMode;
  readonly requested: GitRef;
  readonly resolvedCommit: string;
  readonly lastFetchAt: string | null;
  readonly lastOperationAt: string | null;
}

export interface GitDoctorStatus {
  readonly available: boolean;
  readonly version: string | null;
  readonly minimumVersion: string;
  readonly supported: boolean;
  readonly message: string | null;
}

export interface DoctorResult {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly git: GitDoctorStatus;
  readonly projectRoot: string;
  readonly root: string;
  readonly lockFile: string;
}
