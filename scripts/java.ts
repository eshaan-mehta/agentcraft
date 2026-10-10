import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SERVER_DIR = "server";
export const SERVER_INFO = path.join(SERVER_DIR, "version.json");

export interface ServerInfo {
  version: string;
  javaMajor: number;
}

function majorVersion(java: string): number | null {
  // `java -version` prints to stderr, e.g. `openjdk version "21.0.5" 2024-10-15`.
  const result = spawnSync(java, ["-version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return parseMajor(`${result.stderr}${result.stdout}`);
}

function parseMajor(text: string): number | null {
  const match = text.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = Number(match[1]);
  return major === 1 ? Number(match[2]) : major; // "1.8.0" means Java 8
}

/** Finds a Java runtime at least `minMajor`, preferring JAVA_HOME and Homebrew installs. */
export function findJava(minMajor: number): { path: string; major: number } | null {
  const candidates = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin", "java"),
    ...[25, 21].flatMap((v) => [`/opt/homebrew/opt/openjdk@${v}/bin/java`, `/usr/local/opt/openjdk@${v}/bin/java`]),
    "/opt/homebrew/opt/openjdk/bin/java",
    "java",
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if (candidate !== "java" && !fs.existsSync(candidate)) continue;
    const major = majorVersion(candidate);
    if (major !== null && major >= minMajor) return { path: candidate, major };
  }
  return null;
}

export function javaInstallHint(major: number): string {
  return `Install it with: brew install openjdk@${major}`;
}
