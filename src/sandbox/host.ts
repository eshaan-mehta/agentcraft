import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Method } from "../api.js";
import { ActionError, Interrupted, abortError, errorText } from "../errors.js";

// The worker's real path: the permission model allows reading exactly this file.
const WORKER = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.cjs"));

export interface ScriptResult {
  ok: boolean;
  value?: unknown;
  error?: { message: string; code?: string; stack?: string };
  logs: string[];
  calls: number;
  seconds: number;
}

export interface RunOptions {
  api: Record<string, Method>;
  /** Saved skills, callable from the script as api.skill(name, args). */
  skills: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
  onLog?: (text: string) => void;
}

/**
 * Runs agent-written JavaScript in a locked-down child process. The script is the
 * body of `async (api, args, log) => { ... }`; its return value comes back as `value`.
 * Calls that move the bot run one at a time, in order; queries run immediately.
 */
export function runScript(code: string, args: unknown, options: RunOptions): Promise<ScriptResult> {
  const started = Date.now();
  const logs: string[] = [];
  let calls = 0;
  return new Promise((resolve) => {
    const child = fork(WORKER, [], {
      execArgv: ["--permission", `--allow-fs-read=${WORKER}`, "--max-old-space-size=256"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "json",
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));

    let settled = false;
    // A result can come back after the script was stopped (an action finishing late
    // after a reflex took over). By then the process is gone, so drop it quietly.
    const send = (message: object) => {
      if (!settled && child.connected) child.send(message, () => {});
    };
    const finish = (result: Omit<ScriptResult, "logs" | "calls" | "seconds">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      resolve({ ...result, logs, calls, seconds: Math.round((Date.now() - started) / 100) / 10 });
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: { message: `The script ran past its ${Math.round(options.timeoutMs / 1000)}s limit and was stopped.`, code: "TIMEOUT" } }),
      options.timeoutMs,
    );
    const onAbort = () => {
      const err = abortError(options.signal);
      finish({ ok: false, error: { message: err.message, code: err.code } });
    };
    if (options.signal.aborted) return onAbort();
    options.signal.addEventListener("abort", onAbort, { once: true });

    let bodyQueue: Promise<unknown> = Promise.resolve();
    child.on("message", (message: { type: string; id?: number; method?: string; args?: unknown[]; text?: string; ok?: boolean; value?: unknown; error?: ScriptResult["error"] }) => {
      if (message.type === "log") {
        logs.push(message.text ?? "");
        options.onLog?.(message.text ?? "");
      } else if (message.type === "call") {
        calls++;
        const method = options.api[message.method ?? ""];
        const execute = async () => {
          if (!method) throw new ActionError("INVALID", `api.${message.method} doesn't exist. Check the API reference.`);
          if (options.signal.aborted) throw abortError(options.signal);
          return method.run(Array.isArray(message.args) ? message.args : [], options.signal);
        };
        const pending = method?.body ? (bodyQueue = bodyQueue.catch(() => {}).then(execute)) : execute();
        pending.then(
          (value) => {
            send({ type: "result", id: message.id, ok: true, value: toJson(value) });
          },
          (err: unknown) => {
            const raw = (err as { code?: unknown }).code;
            const code = err instanceof ActionError || err instanceof Interrupted ? err.code : typeof raw === "string" ? raw : "ERROR";
            send({ type: "result", id: message.id, ok: false, error: { message: errorText(err), code } });
          },
        );
      } else if (message.type === "done") {
        finish(message.ok ? { ok: true, value: message.value } : { ok: false, error: message.error });
      }
    });
    child.on("error", (err) => finish({ ok: false, error: { message: `The sandbox process failed: ${err.message}` } }));
    child.on("exit", (code) =>
      finish({ ok: false, error: { message: `The sandbox process exited unexpectedly (code ${code}).${stderr ? ` ${stderr.trim().slice(-500)}` : ""}` } }),
    );
    send({ type: "run", code, args: JSON.stringify(args ?? {}), skills: options.skills });
  });
}

/** Strips class instances (Vec3, Map) down to plain JSON for the trip into the sandbox. */
function toJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_key, v) => (v instanceof Map ? Object.fromEntries(v) : v)));
}
