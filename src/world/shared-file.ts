// JSON files that several agent processes can share (a team's memory and skills):
// reads pick up other processes' changes, and writes take a lock and re-read first,
// so nobody's update is lost.
import fs from "node:fs";

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `fn` while holding a lock beside `file`, so processes sharing the file take turns. */
export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      fs.mkdirSync(lock); // atomic: exactly one process succeeds
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let stale = Date.now() > deadline;
      try {
        // A lock left behind by a crashed process is cleared after 10s.
        stale ||= Date.now() - fs.statSync(lock).mtimeMs > 10_000;
      } catch {
        continue; // released between our mkdir and stat
      }
      if (stale) fs.rmSync(lock, { recursive: true, force: true });
      else sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Writes via a temp file and rename, so readers never see half a file. */
export function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export class SharedJson<T extends object> {
  private cache: T;
  private version = "";

  constructor(
    private readonly file: string,
    private readonly empty: () => T,
  ) {
    this.cache = empty();
  }

  /** The current contents, re-read only if the file changed on disk. */
  read(): T {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      this.cache = this.empty();
      this.version = "";
      return this.cache;
    }
    const version = `${stat.mtimeMs}:${stat.size}`;
    if (version !== this.version) {
      try {
        this.cache = { ...this.empty(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
        this.version = version;
      } catch {
        // Mid-replace or corrupt: keep the last good copy.
      }
    }
    return this.cache;
  }

  /** Applies a change under the lock, on top of the latest contents from disk. */
  update<R>(change: (data: T) => R): R {
    return withFileLock(this.file, () => {
      this.version = "";
      const data = this.read();
      const result = change(data);
      writeAtomic(this.file, JSON.stringify(data, null, 2));
      const stat = fs.statSync(this.file);
      this.version = `${stat.mtimeMs}:${stat.size}`;
      this.cache = data;
      return result;
    });
  }
}
