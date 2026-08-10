import { isAbsolute, join, relative, resolve } from "@std/path";
import {
  InvalidRepositoryIdError,
  InvalidRepositoryNameError,
  PathOutsideRootError,
} from "./errors.ts";
import type { RepositoryId, RepositorySelector } from "./types.ts";

const PORTABLE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export interface StoreLayout {
  readonly projectRoot: string;
  readonly root: string;
  readonly lockFile: string;
  readonly stateFile: string;
  readonly locksRoot: string;
}

export interface RepositoryLayout {
  readonly repositoryHome: string;
  readonly checkoutPath: string;
  readonly operationLockParent: string;
  readonly operationLockPath: string;
}

export function validateRepositoryName(name: string): void {
  if (!PORTABLE_COMPONENT.test(name)) {
    throw new InvalidRepositoryNameError(
      name,
      "use 1-128 ASCII letters, digits, dots, underscores, or hyphens, starting with a letter or digit",
    );
  }
  if (name === "." || name === ".." || name.endsWith(".") || WINDOWS_RESERVED.test(name)) {
    throw new InvalidRepositoryNameError(name, "the name is reserved or not portable");
  }
}

export function validateRepositoryId(id: RepositoryId): void {
  try {
    validateRepositoryName(id.provider);
    validateRepositoryName(id.name);
  } catch (cause) {
    if (cause instanceof InvalidRepositoryNameError) {
      throw new InvalidRepositoryIdError(id.provider, id.name, cause.message);
    }
    throw cause;
  }
}

export function repositoryKey(id: RepositoryId): string {
  validateRepositoryId(id);
  return `${id.provider}/${id.name}`;
}

export function parseRepositorySelector(selector: RepositorySelector): RepositoryId {
  if (typeof selector !== "string") {
    validateRepositoryId(selector);
    return { provider: selector.provider, name: selector.name };
  }
  const parts = selector.split("/");
  if (parts.length !== 2) {
    throw new InvalidRepositoryIdError("", selector, "expected provider/name");
  }
  const id = { provider: parts[0], name: parts[1] };
  validateRepositoryId(id);
  return id;
}

export function parseRepositoryKey(key: string): RepositoryId {
  return parseRepositorySelector(key);
}

export function createStoreLayout(options: {
  projectRoot?: string;
  root?: string;
  lockFile?: string;
}): StoreLayout {
  const projectRoot = resolve(options.projectRoot ?? Deno.cwd());
  const root = resolveFrom(projectRoot, options.root ?? ".source-ref");
  const lockFile = resolveFrom(projectRoot, options.lockFile ?? "source-ref.lock.json");
  return {
    projectRoot,
    root,
    lockFile,
    stateFile: join(root, "state.json"),
    locksRoot: join(root, ".locks"),
  };
}

export function createRepositoryLayout(layout: StoreLayout, id: RepositoryId): RepositoryLayout {
  validateRepositoryId(id);
  const repositoryHome = containedJoin(layout.root, id.provider, id.name);
  const checkoutPath = containedJoin(layout.root, id.provider, id.name, "git-src");
  const operationLockParent = containedJoin(layout.locksRoot, id.provider);
  const operationLockPath = containedJoin(layout.locksRoot, id.provider, `${id.name}.lock`);
  return { repositoryHome, checkoutPath, operationLockParent, operationLockPath };
}

export function assertPathContained(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const rel = relative(absoluteRoot, absoluteCandidate);
  if (
    rel === ".." || rel.startsWith(`..${Deno.build.os === "windows" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw new PathOutsideRootError(absoluteRoot, absoluteCandidate);
  }
  return absoluteCandidate;
}

function containedJoin(root: string, ...parts: string[]): string {
  return assertPathContained(root, join(root, ...parts));
}

function resolveFrom(base: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}
