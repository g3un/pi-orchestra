#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const serverUrl = trimTrailingSlash(
  process.env.FORGEJO_SERVER_URL ?? process.env.GITHUB_SERVER_URL ?? "https://codeberg.org",
);
const repository = process.env.FORGEJO_REPOSITORY ?? process.env.GITHUB_REPOSITORY;
const token = process.env.FORGEJO_TOKEN ?? process.env.GITHUB_TOKEN;
const tagName = process.argv[2] ?? process.env.FORGEJO_TAG_NAME;
const version = packageJson.version;
const packageName = packageJson.name;

if (!repository) {
  fail("FORGEJO_REPOSITORY or GITHUB_REPOSITORY is required.");
}

if (!token) {
  fail("FORGEJO_TOKEN or GITHUB_TOKEN is required.");
}

if (!tagName) {
  fail("Tag name argument or FORGEJO_TAG_NAME is required.");
}

if (tagName !== `v${version}`) {
  fail(`Tag must match package.json version. Tag: ${tagName}; expected: v${version}`);
}

const encodedRepository = repository
  .split("/")
  .map((part) => encodeURIComponent(part))
  .join("/");
const releaseByTagUrl = `${serverUrl}/api/v1/repos/${encodedRepository}/releases/tags/${encodeURIComponent(tagName)}`;
const releasesUrl = `${serverUrl}/api/v1/repos/${encodedRepository}/releases`;

const existingRelease = await request(releaseByTagUrl, { method: "GET" });
if (existingRelease.status === 200) {
  const release = await existingRelease.json();
  console.log(`Forgejo release already exists: ${release.html_url ?? tagName}`);
  process.exit(0);
}

if (existingRelease.status !== 404) {
  await failResponse("Failed to check existing Forgejo release", existingRelease);
}

const fallbackBody = `Published ${packageName}@${version} to npm.`;
let releaseBody = fallbackBody;
try {
  const previousTag = git(
    "describe",
    "--tags",
    "--abbrev=0",
    "--always",
    "--match",
    "v*",
    "--exclude",
    tagName,
    tagName,
  );
  if (previousTag.startsWith("v")) {
    releaseBody =
      git("log", "--format=- %s", "--invert-grep", "--grep", "^release: v", `${previousTag}..${tagName}`) ||
      fallbackBody;
  }
} catch (error) {
  console.warn(`Failed to generate release notes; using fallback body: ${error.message}`);
}

const createRelease = await request(releasesUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    tag_name: tagName,
    name: tagName,
    body: releaseBody,
    draft: false,
  }),
});

if (createRelease.status === 201) {
  const release = await createRelease.json();
  console.log(`Created Forgejo release: ${release.html_url ?? tagName}`);
  process.exit(0);
}

if (createRelease.status === 409) {
  console.log(`Forgejo release already exists for ${tagName}.`);
  process.exit(0);
}

await failResponse("Failed to create Forgejo release", createRelease);

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function request(url, options) {
  return fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `token ${token}`,
      ...options?.headers,
    },
  });
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

async function failResponse(message, response) {
  const body = await response.text();
  fail(`${message}: HTTP ${response.status} ${response.statusText}\n${body}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
