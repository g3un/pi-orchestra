#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const [headTag] = listTags("--points-at", "HEAD", "--list", "v*");
if (headTag) {
  console.log(headTag.slice(1));
  process.exit(0);
}

const dateParts = Object.fromEntries(
  new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date())
    .map(({ type, value }) => [type, value]),
);
const date = `${dateParts.year}${dateParts.month}${dateParts.day}`;
const prefix = `v1.${date}.`;
const tags = listTags("--list", `${prefix}*`);
const next = tags.reduce((highest, tag) => {
  const patch = Number(tag.slice(prefix.length));
  return Number.isSafeInteger(patch) && tag === `${prefix}${patch}` ? Math.max(highest, patch + 1) : highest;
}, 0);

console.log(`1.${date}.${next}`);

function listTags(...args) {
  return execFileSync("git", ["tag", ...args], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
}
