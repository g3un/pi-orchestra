import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const script = fileURLToPath(new URL("../scripts/next-release-version.mjs", import.meta.url));

test("reuses a HEAD tag or increments the current Asia/Seoul release number", () => {
  const bin = mkdtempSync(join(tmpdir(), "next-release-version-"));
  const git = join(bin, "git");
  const run = () =>
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `globalThis.Date = class extends Date { constructor() { super("2026-01-01T15:30:00Z"); } }; await import("${pathToFileURL(script).href}");`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: bin },
      },
    ).trim();

  try {
    writeFileSync(
      git,
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes("--points-at")) process.exit(0);\nconst prefix = args.at(-1).slice(0, -1);\nconsole.log(prefix + "0\\n" + prefix + "2");\n`,
      { mode: 0o755 },
    );
    expect(run()).toBe("1.20260102.3");

    writeFileSync(
      git,
      `#!${process.execPath}\nif (process.argv.includes("--points-at")) console.log("v1.20260102.7");\nelse process.exit(1);\n`,
      { mode: 0o755 },
    );
    expect(run()).toBe("1.20260102.7");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
