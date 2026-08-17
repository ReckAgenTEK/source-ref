const DEFAULT_CAPTURE_LIMIT = 1024 * 1024;

export interface CommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  readonly onStdout?: (chunk: Uint8Array) => void | Promise<void>;
  readonly onStderr?: (chunk: Uint8Array) => void | Promise<void>;
}

export interface CommandResult {
  readonly success: boolean;
  readonly code: number;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export class CommandRunnerAbortError extends Error {
  constructor(options?: ErrorOptions) {
    super("Command was aborted", options);
    this.name = "CommandRunnerAbortError";
  }
}

export class DenoCommandRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    if (request.signal?.aborted) throw new CommandRunnerAbortError();
    const limit = request.maxOutputBytes ?? DEFAULT_CAPTURE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new TypeError("maxOutputBytes must be a non-negative safe integer");
    }

    const started = performance.now();
    const child = new Deno.Command(request.executable, {
      args: [...request.args],
      cwd: request.cwd,
      env: request.env ? { ...request.env } : undefined,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    let aborted = false;
    const abort = () => {
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The child may have exited between the abort event and kill().
      }
    };
    request.signal?.addEventListener("abort", abort, { once: true });

    try {
      const [status, stdout, stderr] = await Promise.all([
        child.status,
        consume(child.stdout, limit, request.onStdout),
        consume(child.stderr, limit, request.onStderr),
      ]);
      if (aborted || request.signal?.aborted) throw new CommandRunnerAbortError();
      return {
        success: status.success,
        code: status.code,
        signal: status.signal,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: performance.now() - started,
      };
    } catch (cause) {
      if (aborted || request.signal?.aborted || cause instanceof CommandRunnerAbortError) {
        throw new CommandRunnerAbortError({ cause });
      }
      throw cause;
    } finally {
      request.signal?.removeEventListener("abort", abort);
    }
  }
}

async function consume(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  callback?: (chunk: Uint8Array) => void | Promise<void>,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;
  let callbackError: unknown;

  for await (const chunk of stream) {
    if (callback && callbackError === undefined) {
      try {
        await callback(chunk);
      } catch (cause) {
        callbackError = cause;
      }
    }
    const remaining = limit - retained;
    if (remaining > 0) {
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      chunks.push(kept);
      retained += kept.length;
    }
    if (chunk.length > remaining) truncated = true;
  }

  if (callbackError !== undefined) throw callbackError;
  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}
