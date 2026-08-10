import { fromFileUrl, resolve, toFileUrl } from "@std/path";
import { InvalidRepositoryUrlError } from "./errors.ts";

const KNOWN_PROVIDERS: Readonly<Record<string, string>> = {
  "github.com": "github",
  "codeberg.org": "codeberg",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
};

export interface ParsedRepositoryUrl {
  /** Canonical, credential-free URL/path suitable for passing directly to Git. */
  readonly url: string;
  /** Protocol-independent identity used for collision checks. */
  readonly identity: string;
  readonly provider: string;
  readonly defaultName: string;
  readonly kind: "remote" | "local";
}

export function redactUrl(value: string): string {
  if (!value) return value;

  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "redacted" : "";
      parsed.password = parsed.password ? "redacted" : "";
    }
    for (const key of parsed.searchParams.keys()) parsed.searchParams.set(key, "redacted");
    if (parsed.hash) parsed.hash = "#redacted";
    return parsed.toString();
  } catch {
    return value
      .replace(
        /^(\s*[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]*@/,
        "$1redacted@",
      )
      .replace(/^([^@/:\s]+):([^@\s]+)@/, "redacted:redacted@")
      .replace(/([?&][^#&=\s]*=)[^&#\s]*/g, "$1redacted")
      .replace(/#.*$/, "#redacted");
  }
}

export function parseRepositoryUrl(input: string, projectRoot = Deno.cwd()): ParsedRepositoryUrl {
  const value = input.trim();
  if (!value || value.includes("\0") || /[\r\n]/.test(value)) {
    throw invalid(input, "the value is empty or contains control characters");
  }

  if (isExplicitLocalPath(value) || !hasUriScheme(value) && !looksLikeScp(value)) {
    return parseLocalPath(value, projectRoot);
  }

  const scp = hasUriScheme(value) ? null : parseScp(value);
  if (scp) {
    const host = normalizeHost(scp.host);
    const path = normalizeRemotePath(scp.path);
    const defaultName = repositoryNameFromPath(path, input);
    const user = scp.user ? `${scp.user}@` : "";
    return {
      url: `${user}${hostForDisplay(host)}:${scp.path}`,
      identity: remoteIdentity(host, "", path),
      provider: providerForHost(host, ""),
      defaultName,
      kind: "remote",
    };
  }

  let parsed: URL;
  try {
    const normalized = /^git:[^/]/i.test(value) ? `git://${value.slice(4)}` : value;
    parsed = new URL(normalized);
  } catch (cause) {
    throw invalid(input, "the URL could not be parsed", cause);
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "file:") return parseFileUrl(parsed, input);
  if (!parsed.hostname) throw invalid(input, "a remote URL must include a hostname");
  if (parsed.search || parsed.hash) {
    throw invalid(input, "query strings and fragments are not accepted in repository URLs");
  }
  if (parsed.password || parsed.username && protocol !== "ssh:") {
    throw invalid(input, "embedded credentials are not accepted");
  }

  const host = normalizeHost(parsed.hostname);
  const path = normalizeRemotePath(safeDecodePath(parsed.pathname, input));
  const defaultName = repositoryNameFromPath(path, input);
  parsed.protocol = protocol;
  parsed.hostname = host;
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");

  return {
    url: parsed.toString(),
    identity: remoteIdentity(host, parsed.port, path),
    provider: providerForHost(host, parsed.port),
    defaultName,
    kind: "remote",
  };
}

function parseFileUrl(parsed: URL, original: string): ParsedRepositoryUrl {
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw invalid(original, "file URLs cannot contain credentials, queries, or fragments");
  }

  let path: string;
  try {
    path = resolve(fromFileUrl(parsed));
  } catch (cause) {
    throw invalid(original, "the file URL does not contain a valid local path", cause);
  }
  const defaultName = repositoryNameFromPath(path.replaceAll("\\", "/"), original);
  return {
    url: toFileUrl(path).href,
    identity: `local:${normalizeLocalIdentity(path)}`,
    provider: "local",
    defaultName,
    kind: "local",
  };
}

function parseLocalPath(value: string, projectRoot: string): ParsedRepositoryUrl {
  const path = resolve(projectRoot, value);
  const defaultName = repositoryNameFromPath(path.replaceAll("\\", "/"), value);
  return {
    url: path,
    identity: `local:${normalizeLocalIdentity(path)}`,
    provider: "local",
    defaultName,
    kind: "local",
  };
}

function parseScp(value: string): { user: string; host: string; path: string } | null {
  if (!looksLikeScp(value)) return null;
  const match = /^(?:([^@/:\s]+)@)?(\[[^\]]+\]|[^:/\\\s]+):(.+)$/.exec(value);
  if (!match) return null;
  if (!match[3] || /[\r\n\0]/.test(match[3])) return null;
  return {
    user: match[1] ?? "",
    host: match[2].replace(/^\[|\]$/g, ""),
    path: match[3],
  };
}

function looksLikeScp(value: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  if (/^(?:\.\.?[\\/]|[\\/])/.test(value)) return false;
  return /^(?:[^@/:\s]+@)?(?:\[[^\]]+\]|[^:/\\\s]+):.+$/.test(value);
}

function isExplicitLocalPath(value: string): boolean {
  return /^(?:\.\.?[\\/]|[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

function hasUriScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function hostForDisplay(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function normalizeRemotePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  return normalized.replace(/\.git$/i, "");
}

function normalizeLocalIdentity(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return Deno.build.os === "windows" ? normalized.toLowerCase() : normalized;
}

function remoteIdentity(host: string, port: string, path: string): string {
  return `remote:${host}${port ? `:${port}` : ""}/${path}`;
}

function providerForHost(host: string, port: string): string {
  const known = KNOWN_PROVIDERS[host];
  if (known) return known;
  const source = `${host}${port ? `-${port}` : ""}`;
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "unknown-host";
}

function repositoryNameFromPath(path: string, original: string): string {
  const component = path.replace(/\/+$/, "").split("/").at(-1) ?? "";
  const name = component.replace(/\.git$/i, "");
  if (!name) throw invalid(original, "the repository path has no final name component");
  return name;
}

function safeDecodePath(path: string, original: string): string {
  try {
    const decoded = decodeURIComponent(path);
    if (
      [...decoded].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      })
    ) {
      throw invalid(original, "the URL path contains encoded control characters");
    }
    return decoded;
  } catch (cause) {
    if (cause instanceof InvalidRepositoryUrlError) throw cause;
    throw invalid(original, "the URL path contains invalid percent encoding", cause);
  }
}

function invalid(input: string, reason: string, _cause?: unknown): InvalidRepositoryUrlError {
  return new InvalidRepositoryUrlError(redactUrl(input), reason);
}
