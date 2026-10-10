// What the bot knows that survives restarts: named places, what's in chests, lessons
// learned, and standing orders from the supervisor. Teammates share one memory file;
// every read picks up their changes and every write is safe against theirs.
import fs from "node:fs";
import path from "node:path";
import { formatPos, type Pos } from "./perception.js";
import { SharedJson } from "./shared-file.js";

interface Waypoint extends Pos {
  note?: string;
  updated: string;
  by?: string;
}

interface Container {
  block: string;
  items: Record<string, number>;
  updated: string;
}

interface Entry {
  id: number;
  text: string;
  tags: string[];
  created: string;
  by?: string;
}

interface MemoryData {
  nextId: number;
  waypoints: Record<string, Waypoint>;
  containers: Record<string, Container>;
  notes: Entry[];
  orders: Entry[];
}

const empty = (): MemoryData => ({ nextId: 1, waypoints: {}, containers: {}, notes: [], orders: [] });

export class Memory {
  private readonly store: SharedJson<MemoryData>;

  /** `author` is recorded on places and notes, so teammates can see who added what. */
  constructor(
    dir: string,
    private readonly author?: string,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.store = new SharedJson(path.join(dir, "memory.json"), empty);
  }

  private get data(): MemoryData {
    return this.store.read();
  }

  setWaypoint(name: string, pos: Pos, note?: string) {
    this.store.update((d) => {
      d.waypoints[name.toLowerCase()] = {
        x: Math.floor(pos.x),
        y: Math.floor(pos.y),
        z: Math.floor(pos.z),
        note,
        updated: new Date().toISOString(),
        by: this.author,
      };
    });
  }

  waypoint(name: string): Waypoint | null {
    return this.data.waypoints[name.toLowerCase()] ?? null;
  }

  removeWaypoint(name: string): boolean {
    return this.store.update((d) => {
      const existed = name.toLowerCase() in d.waypoints;
      delete d.waypoints[name.toLowerCase()];
      return existed;
    });
  }

  recordContainer(pos: Pos, block: string, items: Record<string, number>) {
    this.store.update((d) => {
      d.containers[formatPos(pos)] = { block, items, updated: new Date().toISOString() };
    });
  }

  add(kind: "note" | "order", text: string, tags: string[] = []): number {
    return this.store.update((d) => {
      const entry = { id: d.nextId++, text, tags, created: new Date().toISOString(), by: this.author };
      (kind === "note" ? d.notes : d.orders).push(entry);
      return entry.id;
    });
  }

  forget(id: number): boolean {
    return this.store.update((d) => {
      const before = d.notes.length + d.orders.length;
      d.notes = d.notes.filter((e) => e.id !== id);
      d.orders = d.orders.filter((e) => e.id !== id);
      return d.notes.length + d.orders.length < before;
    });
  }

  /** Keyword search across everything remembered. */
  recall(query: string): string {
    const data = this.data;
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const score = (text: string) => words.reduce((s, w) => s + (text.toLowerCase().includes(w) ? 1 : 0), 0);
    const by = (who?: string) => (who && who !== this.author ? ` (from ${who})` : "");
    const hits: { score: number; line: string }[] = [];
    for (const e of [...data.notes, ...data.orders]) {
      const s = words.length ? score(`${e.text} ${e.tags.join(" ")}`) : 1;
      if (s) hits.push({ score: s, line: `#${e.id} ${data.orders.includes(e) ? "[order]" : "[note]"} ${e.text}${by(e.by)}` });
    }
    for (const [name, w] of Object.entries(data.waypoints)) {
      const s = words.length ? score(`${name} ${w.note ?? ""}`) : 1;
      if (s) hits.push({ score: s, line: `[place] ${name}: ${formatPos(w)}${w.note ? ` (${w.note})` : ""}${by(w.by)}` });
    }
    for (const [pos, c] of Object.entries(data.containers)) {
      const s = words.length ? score(Object.keys(c.items).join(" ") + ` ${c.block}`) : 1;
      if (s) hits.push({ score: s, line: `[${c.block}] ${pos}: ${formatItems(c.items)} (as of ${c.updated.slice(0, 16)})` });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.length ? hits.slice(0, 25).map((h) => h.line).join("\n") : `Nothing remembered about "${query}".`;
  }

  /** A short digest for the start of each new message: orders, places, storage. */
  digest(): string {
    const data = this.data;
    const lines: string[] = [];
    if (data.orders.length) lines.push(`Standing orders: ${data.orders.map((o) => `#${o.id} ${o.text}`).join("; ")}`);
    const places = Object.entries(data.waypoints).slice(-12);
    if (places.length) lines.push(`Known places: ${places.map(([n, w]) => `${n} ${formatPos(w)}`).join("; ")}`);
    const chests = Object.entries(data.containers).slice(-6);
    if (chests.length) lines.push(`Storage: ${chests.map(([p, c]) => `${c.block} ${p} [${formatItems(c.items, 5)}]`).join("; ")}`);
    if (data.notes.length) lines.push(`${data.notes.length} saved notes (use recall to search them).`);
    return lines.join("\n");
  }
}

function formatItems(items: Record<string, number>, limit = 20): string {
  const entries = Object.entries(items).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "empty";
  const shown = entries.slice(0, limit).map(([n, c]) => `${n} x${c}`).join(", ");
  return entries.length > limit ? `${shown}, +${entries.length - limit} more` : shown;
}
