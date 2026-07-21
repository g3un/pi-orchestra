import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const script = fileURLToPath(new URL("../scripts/create-forgejo-release.mjs", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function createReleaseBody(previousTag: string | undefined, notes = "") {
  const bin = mkdtempSync(join(tmpdir(), "create-forgejo-release-"));

  try {
    writeFileSync(
      join(bin, "git"),
      `#!${process.execPath}\nconst command = process.argv[2];\nif (command === "log" && (!process.argv.includes("--invert-grep") || !process.argv.includes("^release: v"))) process.exit(1);\nconst output = { describe: ${JSON.stringify(previousTag)}, log: ${JSON.stringify(notes)} }[command];\nif (output === undefined) process.exit(1);\nprocess.stdout.write(output);\n`,
      { mode: 0o755 },
    );
    const mockFetch = `
      process.argv[2] = "v${packageJson.version}";
      console.warn = () => {};
      globalThis.fetch = async (_url, options) => {
        if (options.method === "GET") return { status: 404 };
        console.log("REQUEST=" + options.body);
        return { status: 201, json: async () => ({}) };
      };
      await import(${JSON.stringify(pathToFileURL(script).href)});
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", mockFetch], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bin,
        FORGEJO_REPOSITORY: "owner/repository",
        FORGEJO_SERVER_URL: "https://forgejo.example",
        FORGEJO_TOKEN: "token",
      },
    });
    const request = output.split("\n").find((line) => line.startsWith("REQUEST="));
    if (!request) throw new Error("Release request was not captured.");
    return JSON.parse(request.slice("REQUEST=".length)).body;
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test("uses commit subjects and falls back when notes are unavailable or empty", () => {
  const notes = "- fix: handle failure (#2)\n- feat: add release notes (#1)";
  const fallback = `Published ${packageJson.name}@${packageJson.version} to npm.`;

  expect(createReleaseBody("v1.previous", notes)).toBe(notes);
  expect(createReleaseBody("abc123")).toBe(fallback);
  expect(createReleaseBody("v1.previous")).toBe(fallback);
  expect(createReleaseBody(undefined)).toBe(fallback);
});
