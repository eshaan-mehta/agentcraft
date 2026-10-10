// Skills the agent has written and saved: JavaScript that ran successfully in the
// sandbox, kept on disk so later tasks, later sessions, and teammates can reuse it.
import fs from "node:fs";
import path from "node:path";
import { ActionError } from "../errors.js";
import { SharedJson, writeAtomic } from "../world/shared-file.js";

export interface SkillMeta {
  name: string;
  description: string;
  /** What `args` the skill expects, e.g. "{ count: number, near?: {x,y,z} }". */
  params: string;
  created: string;
  updated: string;
  runs: number;
  failures: number;
  /** Which agent saved it (useful when a team shares skills). */
  by?: string;
}

const NAME = /^[a-z][a-zA-Z0-9_]{1,40}$/;

export class SkillLibrary {
  private readonly index: SharedJson<Record<string, SkillMeta>>;

  constructor(
    private readonly dir: string,
    private readonly author?: string,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.index = new SharedJson(path.join(dir, "index.json"), () => ({}));
  }

  private file(name: string) {
    return path.join(this.dir, `${name}.js`);
  }

  save(name: string, description: string, params: string, code: string): SkillMeta {
    if (!NAME.test(name)) throw new ActionError("INVALID", `Skill names must be camelCase identifiers like "farmWheat" (got "${name}").`);
    writeAtomic(this.file(name), code);
    return this.index.update((index) => {
      const now = new Date().toISOString();
      const existing = index[name];
      const meta: SkillMeta = {
        name,
        description,
        params,
        created: existing?.created ?? now,
        updated: now,
        runs: existing?.runs ?? 0,
        failures: existing?.failures ?? 0,
        by: this.author,
      };
      index[name] = meta;
      return meta;
    });
  }

  get(name: string): { meta: SkillMeta; code: string } {
    const meta = this.index.read()[name];
    if (!meta || !fs.existsSync(this.file(name))) {
      throw new ActionError("NOT_FOUND", `No saved skill "${name}". Saved skills: ${Object.keys(this.index.read()).join(", ") || "none"}.`);
    }
    return { meta, code: fs.readFileSync(this.file(name), "utf8") };
  }

  remove(name: string): boolean {
    return this.index.update((index) => {
      if (!index[name]) return false;
      delete index[name];
      fs.rmSync(this.file(name), { force: true });
      return true;
    });
  }

  recordRun(name: string, ok: boolean) {
    this.index.update((index) => {
      const meta = index[name];
      if (!meta) return;
      meta.runs++;
      if (!ok) meta.failures++;
    });
  }

  list(): SkillMeta[] {
    return Object.values(this.index.read()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** All skill code, for loading into a sandbox run so scripts can call each other. */
  sources(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of Object.keys(this.index.read())) {
      if (fs.existsSync(this.file(name))) out[name] = fs.readFileSync(this.file(name), "utf8");
    }
    return out;
  }

  describe(): string {
    const skills = this.list();
    if (!skills.length) return "No saved skills yet.";
    return skills
      .map((s) => `- ${s.name}(args: ${s.params || "none"}): ${s.description} [runs ${s.runs}, failures ${s.failures}${s.by && s.by !== this.author ? `, by ${s.by}` : ""}]`)
      .join("\n");
  }
}
