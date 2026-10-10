// Runs one agent-written script, isolated twice over:
//  1. This process is started with Node's permission model: no file reads beyond this
//     file, no file writes, no child processes, no worker threads.
//  2. The script runs in a vm context with no Node globals (no process, require,
//     fetch), string code generation (eval, new Function) disabled, and no references
//     to objects from this realm: everything crossing the boundary is a primitive or a
//     JSON string, so there's no prototype chain to climb out through.
// The script's only capability is `api`, whose calls are forwarded to the parent
// process, which owns the bot.
"use strict";
const vm = require("node:vm");

let deliver = null;
const pending = new Set();
let nextId = 1;

function send(message) {
  if (process.connected) process.send(message);
}

// The single bridge into the sandbox. A null prototype means `host.constructor` and
// friends don't exist, and it only ever returns numbers.
function host(kind, payload) {
  try {
    if (kind === "call") {
      const split = payload.indexOf("\u0000");
      const id = nextId++;
      pending.add(id);
      send({ type: "call", id, method: payload.slice(0, split), args: JSON.parse(payload.slice(split + 1)) });
      return id;
    }
    if (kind === "log") {
      send({ type: "log", text: String(payload).slice(0, 4000) });
      return 0;
    }
    if (kind === "done") {
      send({ type: "done", ...JSON.parse(payload) });
      return 0;
    }
  } catch {
    // Never let an exception (an object from this realm) reach the sandbox.
  }
  return -1;
}
Object.setPrototypeOf(host, null);

const BOOTSTRAP = `
(() => {
  const bridge = globalThis.__host;
  delete globalThis.__host;
  const waiting = new Map();
  const toText = (v) => (typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());
  const log = (...parts) => { bridge("log", parts.map(toText).join(" ")); };
  const call = (method, args) => new Promise((resolve, reject) => {
    let json;
    try { json = JSON.stringify(args); } catch { reject(new Error("api arguments must be plain JSON data")); return; }
    const id = bridge("call", method + "\\u0000" + json);
    if (id < 0) { reject(new Error("api call failed to send")); return; }
    waiting.set(id, { resolve, reject });
  });
  const skills = globalThis.__skills || {};
  const api = new Proxy({}, {
    get(_, name) {
      // "then" would make api look like a promise; "toJSON" would be called by JSON.stringify.
      if (typeof name !== "string" || name === "then" || name === "toJSON") return undefined;
      if (name === "skill") {
        return (skillName, args) => {
          const fn = skills[skillName];
          if (!fn) return Promise.reject(new Error("No saved skill named " + skillName));
          return fn(api, args === undefined ? {} : args, log);
        };
      }
      return (...args) => call(name, args);
    },
  });
  globalThis.__deliver = (id, json) => {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    const r = JSON.parse(json);
    if (r.ok) w.resolve(r.value);
    else { const e = new Error(r.error.message); e.code = r.error.code; w.reject(e); }
  };
  globalThis.__finish = async () => {
    try {
      const value = await globalThis.__main(api, globalThis.__args, log);
      let json;
      try { json = JSON.stringify({ ok: true, value: value === undefined ? null : value }); }
      catch { json = JSON.stringify({ ok: true, value: String(value) }); }
      bridge("done", json);
    } catch (e) {
      const message = e && e.message ? String(e.message) : String(e);
      // Keep only the script's own frames: sandbox plumbing means nothing to the author.
      const stack = e && e.stack ? String(e.stack).split("\\n").filter((l) => /script\\.js|skill:/.test(l)).slice(0, 5).join("\\n") : "";
      bridge("done", JSON.stringify({ ok: false, error: { message, code: e && e.code ? String(e.code) : undefined, stack } }));
    }
  };
  globalThis.console = { log, info: log, warn: log, error: log };
})();
`;

function run({ code, args, skills }) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  context.__host = host;
  try {
    // Saved skills become functions inside the sandbox so scripts can call api.skill(name, args).
    vm.runInContext("globalThis.__skills = {};", context);
    for (const [name, source] of Object.entries(skills || {})) {
      new vm.Script(`globalThis.__skills[${JSON.stringify(name)}] = async (api, args, log) => {\n${source}\n};`, { filename: `skill:${name}.js` }).runInContext(context);
    }
    new vm.Script(BOOTSTRAP, { filename: "bootstrap.js" }).runInContext(context);
    vm.runInContext(`globalThis.__args = JSON.parse(${JSON.stringify(args)});`, context);
    new vm.Script(`globalThis.__main = async (api, args, log) => {\n${code}\n};`, { filename: "script.js" }).runInContext(context);
  } catch (err) {
    send({ type: "done", ok: false, error: { message: `Script didn't compile: ${err && err.message}`, code: "INVALID" } });
    return;
  }
  deliver = vm.runInContext("__deliver", context);
  vm.runInContext("__finish()", context);
}

process.on("message", (message) => {
  if (message.type === "run") run(message);
  else if (message.type === "result" && pending.delete(message.id) && deliver) {
    const payload = message.ok ? { ok: true, value: message.value === undefined ? null : message.value } : { ok: false, error: message.error };
    deliver(message.id, JSON.stringify(payload));
  }
});
