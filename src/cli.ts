/**
 * Command-line interface for deterministic source checkouts.
 *
 * @module
 */

import { CLI_JSON_SCHEMA_VERSION } from "./constants.ts";
import {
  GitCommandError,
  InvalidArgumentError,
  OperationAbortedError,
  SourceRefError,
} from "./errors.ts";
import { parseRepositorySelector, validateRepositoryName } from "./layout.ts";
import { parseRepositoryUrl, redactUrl } from "./repository_url.ts";
import { SourceRefStore } from "./source_ref_store.ts";
import type { CheckoutMode, GitRef, SourceRefStoreOptions } from "./types.ts";

interface CliIo {
  readonly stdout: (text: string) => Promise<void>;
  readonly stderr: (text: string) => Promise<void>;
}

interface ParsedArguments {
  readonly positionals: string[];
  readonly values: Readonly<Record<string, string>>;
  readonly booleans: ReadonlySet<string>;
}

const HELP = `source-ref - deterministic real-Git source checkout manager

Usage:
  source-ref ensure <url> [--name <name>] --ref <ref> --ref-kind <tag|branch|commit> [--mode <pinned|branch>]
  source-ref fetch <provider/name>
  source-ref sync [provider/name]
  source-ref update <provider/name> [--ref <ref> --ref-kind <tag|branch|commit>]
  source-ref checkout <provider/name> --ref <ref> --ref-kind <tag|branch|commit> [--mode <pinned|branch>]
  source-ref pull <provider/name>
  source-ref status [provider/name] [--json]
  source-ref path <provider/name> [--repository-root]
  source-ref list [--json]
  source-ref doctor [--json]

Global options:
  --project-root <path>  Base for relative paths (default: current directory)
  --root <path>          Managed root (default: .source-ref)
  --lock-file <path>     Tracked lock file (default: source-ref.lock.json)
  -h, --help             Show help
`;

const defaultIo: CliIo = {
  stdout: (text) => writeStream(Deno.stdout, text),
  stderr: (text) => writeStream(Deno.stderr, text),
};

/** Runs the source-ref CLI and returns its process exit code. */
export async function runCli(
  args: readonly string[] = Deno.args,
  io: CliIo = defaultIo,
): Promise<number> {
  const jsonRequested = args.includes("--json");
  try {
    const global = parseArguments(
      args,
      ["project-root", "root", "lock-file"],
      ["help", "json"],
      true,
    );
    if (global.booleans.has("help") || global.positionals.length === 0) {
      await io.stdout(HELP);
      return global.positionals.length === 0 && !global.booleans.has("help") ? 2 : 0;
    }

    const command = global.positionals[0];
    const commandArgs = global.positionals.slice(1);
    const storeOptions: SourceRefStoreOptions = {
      ...(global.values["project-root"] ? { projectRoot: global.values["project-root"] } : {}),
      ...(global.values.root ? { root: global.values.root } : {}),
      ...(global.values["lock-file"] ? { lockFile: global.values["lock-file"] } : {}),
    };
    const store = new SourceRefStore(storeOptions);
    const json = global.booleans.has("json");

    switch (command) {
      case "ensure": {
        const parsed = parseArguments(commandArgs, ["name", "ref", "ref-kind", "mode"], []);
        requirePositionals(parsed, 1, 1, command);
        const url = parseRepositoryUrl(parsed.positionals[0], store.projectRoot);
        const name = parsed.values.name ?? url.defaultName;
        validateRepositoryName(name);
        const ref = requiredRef(parsed);
        const mode = parseMode(parsed.values.mode ?? (ref.kind === "branch" ? "branch" : "pinned"));
        await io.stderr(`Ensuring ${url.provider}/${name} from ${redactUrl(url.url)}\n`);
        const result = await store.ensure({
          id: { provider: url.provider, name },
          url: url.url,
          mode,
          ref,
        });
        await outputResult(
          io,
          json,
          command,
          result,
          `${result.checkoutPath} @ ${result.resolvedCommit}\n`,
        );
        return 0;
      }
      case "fetch": {
        const parsed = parseArguments(commandArgs, [], []);
        requirePositionals(parsed, 1, 1, command);
        const id = parseRepositorySelector(parsed.positionals[0]);
        await io.stderr(`Fetching ${id.provider}/${id.name}\n`);
        const result = await store.fetch(id);
        await outputResult(io, json, command, result, `Fetched ${id.provider}/${id.name}\n`);
        return 0;
      }
      case "sync": {
        const parsed = parseArguments(commandArgs, [], []);
        requirePositionals(parsed, 0, 1, command);
        const selector = parsed.positionals[0];
        await io.stderr(`Synchronizing ${selector ?? "all managed repositories"}\n`);
        const result = await store.sync(selector);
        await outputResult(
          io,
          json,
          command,
          result,
          `${result.length} repository(s) synchronized\n`,
        );
        return 0;
      }
      case "update": {
        const parsed = parseArguments(commandArgs, ["ref", "ref-kind"], []);
        requirePositionals(parsed, 1, 1, command);
        const ref = optionalRef(parsed);
        const id = parseRepositorySelector(parsed.positionals[0]);
        await io.stderr(`Updating ${id.provider}/${id.name}\n`);
        const result = await store.update(id, ref ? { ref } : {});
        await outputResult(
          io,
          json,
          command,
          result,
          `${result.checkoutPath} @ ${result.resolvedCommit}\n`,
        );
        return 0;
      }
      case "checkout": {
        const parsed = parseArguments(commandArgs, ["ref", "ref-kind", "mode"], []);
        requirePositionals(parsed, 1, 1, command);
        const ref = requiredRef(parsed);
        const id = parseRepositorySelector(parsed.positionals[0]);
        const mode = parsed.values.mode === undefined ? undefined : parseMode(parsed.values.mode);
        await io.stderr(`Checking out ${id.provider}/${id.name} at ${ref.kind}:${ref.value}\n`);
        const result = await store.checkout(id, ref, mode ? { mode } : {});
        await outputResult(
          io,
          json,
          command,
          result,
          `${result.checkoutPath} @ ${result.resolvedCommit}\n`,
        );
        return 0;
      }
      case "pull": {
        const parsed = parseArguments(commandArgs, [], []);
        requirePositionals(parsed, 1, 1, command);
        const id = parseRepositorySelector(parsed.positionals[0]);
        await io.stderr(`Pulling ${id.provider}/${id.name} with --ff-only\n`);
        const result = await store.pull(id);
        await outputResult(
          io,
          json,
          command,
          result,
          `${result.checkoutPath} @ ${result.resolvedCommit}\n`,
        );
        return 0;
      }
      case "status": {
        const parsed = parseArguments(commandArgs, [], []);
        requirePositionals(parsed, 0, 1, command);
        const statuses = await store.status(parsed.positionals[0]);
        const human = statuses.length === 0
          ? "No managed repositories\n"
          : statuses.map((status) => {
            const state = !status.checkoutExists
              ? "missing"
              : status.dirty
              ? "dirty"
              : status.matchesLock
              ? "locked"
              : "mismatched";
            return `${status.id.provider}/${status.id.name} ${state} ${
              status.currentCommit ?? "-"
            }`;
          }).join("\n") + "\n";
        await outputResult(io, json, command, statuses, human);
        return 0;
      }
      case "path": {
        const parsed = parseArguments(commandArgs, [], ["repository-root"]);
        requirePositionals(parsed, 1, 1, command);
        const path = store.path(parsed.positionals[0], {
          repositoryRoot: parsed.booleans.has("repository-root"),
        });
        if (json) await outputResult(io, true, command, { path }, "");
        else await io.stdout(`${path}\n`);
        return 0;
      }
      case "list": {
        const parsed = parseArguments(commandArgs, [], []);
        requirePositionals(parsed, 0, 0, command);
        const repositories = await store.list();
        const human = repositories.length === 0
          ? "No managed repositories\n"
          : repositories.map((repository) =>
            `${repository.key} ${repository.mode} ${repository.resolvedCommit}`
          ).join("\n") + "\n";
        await outputResult(io, json, command, repositories, human);
        return 0;
      }
      case "doctor": {
        const parsed = parseArguments(commandArgs, [], []);
        requirePositionals(parsed, 0, 0, command);
        const result = await store.doctor();
        const human = result.git.available
          ? `Git ${result.git.version}: ${result.git.supported ? "ok" : "unsupported"}\n`
          : `Git: unavailable (${result.git.message})\n`;
        await outputResult(io, json, command, result, human);
        return result.ok ? 0 : 1;
      }
      default:
        throw new InvalidArgumentError(`Unknown command '${command}'`, { command });
    }
  } catch (cause) {
    const serialized = serializeError(cause);
    if (jsonRequested) {
      await io.stdout(
        `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, error: serialized })}\n`,
      );
    } else {
      await io.stderr(`source-ref: ${serialized.code}: ${serialized.message}\n`);
    }
    if (cause instanceof OperationAbortedError) return 130;
    if (cause instanceof InvalidArgumentError) return 2;
    if (cause instanceof GitCommandError && cause.exitCode > 0 && cause.exitCode <= 255) {
      return cause.exitCode;
    }
    return 1;
  }
}

function parseArguments(
  args: readonly string[],
  valueOptions: readonly string[],
  booleanOptions: readonly string[],
  preserveUnknownOptions = false,
): ParsedArguments {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  let positionalOnly = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (positionalOnly || !argument.startsWith("-") || argument === "-") {
      positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    const normalized = argument === "-h" ? "--help" : argument;
    if (!normalized.startsWith("--")) {
      throw new InvalidArgumentError(`Unknown option '${argument}'`, { option: argument });
    }
    const equals = normalized.indexOf("=");
    const name = normalized.slice(2, equals === -1 ? undefined : equals);
    if (booleanOptions.includes(name)) {
      if (equals !== -1) throw new InvalidArgumentError(`Option '--${name}' does not take a value`);
      booleans.add(name);
      continue;
    }
    if (valueOptions.includes(name)) {
      const value = equals === -1 ? args[++index] : normalized.slice(equals + 1);
      if (value === undefined || value === "") {
        throw new InvalidArgumentError(`Option '--${name}' requires a value`, { option: name });
      }
      if (name in values) {
        throw new InvalidArgumentError(`Option '--${name}' was provided more than once`);
      }
      values[name] = value;
      continue;
    }
    if (preserveUnknownOptions) {
      positionals.push(argument);
      if (equals === -1 && optionLikelyNeedsValue(name) && args[index + 1] !== undefined) {
        positionals.push(args[++index]);
      }
      continue;
    }
    throw new InvalidArgumentError(`Unknown option '${argument}'`, { option: argument });
  }
  return { positionals, values, booleans };
}

function optionLikelyNeedsValue(name: string): boolean {
  return ["name", "ref", "ref-kind", "mode"].includes(name);
}

function requirePositionals(
  parsed: ParsedArguments,
  minimum: number,
  maximum: number,
  command: string,
): void {
  if (parsed.positionals.length < minimum || parsed.positionals.length > maximum) {
    throw new InvalidArgumentError(
      `Command '${command}' expected ${
        minimum === maximum ? minimum : `${minimum}-${maximum}`
      } positional argument(s)`,
      { command, count: parsed.positionals.length },
    );
  }
}

function requiredRef(parsed: ParsedArguments): GitRef {
  const ref = optionalRef(parsed);
  if (!ref) throw new InvalidArgumentError("Both --ref and --ref-kind are required");
  return ref;
}

function optionalRef(parsed: ParsedArguments): GitRef | undefined {
  const value = parsed.values.ref;
  const kind = parsed.values["ref-kind"];
  if (value === undefined && kind === undefined) return undefined;
  if (value === undefined || kind === undefined) {
    throw new InvalidArgumentError("--ref and --ref-kind must be supplied together");
  }
  if (kind !== "tag" && kind !== "branch" && kind !== "commit") {
    throw new InvalidArgumentError(`Invalid --ref-kind '${kind}'`, { kind });
  }
  return { kind, value };
}

function parseMode(value: string): CheckoutMode {
  if (value !== "pinned" && value !== "branch") {
    throw new InvalidArgumentError(`Invalid checkout mode '${value}'`, { mode: value });
  }
  return value;
}

async function outputResult(
  io: CliIo,
  json: boolean,
  command: string,
  result: unknown,
  human: string,
): Promise<void> {
  if (json) {
    await io.stdout(
      `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, command, result })}\n`,
    );
  } else if (human) {
    await io.stdout(human);
  }
}

function serializeError(cause: unknown): { code: string; message: string; details: unknown } {
  if (cause instanceof SourceRefError) {
    return {
      code: cause.code,
      message: redactText(cause.message),
      details: sanitizeDetails(cause.details),
    };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return { code: "INTERNAL_ERROR", message: redactText(message), details: {} };
}

function sanitizeDetails(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(sanitizeDetails);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "cause" && key !== "env").map((
        [key, item],
      ) => [
        key,
        sanitizeDetails(item),
      ]),
    );
  }
  return value;
}

function redactText(value: string): string {
  return value.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"<>]+/g, (url) => redactUrl(url));
}

async function writeStream(
  stream: { write(data: Uint8Array): Promise<number> },
  text: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  while (offset < bytes.length) offset += await stream.write(bytes.subarray(offset));
}

if (import.meta.main) Deno.exit(await runCli());
