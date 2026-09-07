import { execFileSync, spawnSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const base = git("rev-parse", "--verify", "origin/main^{commit}");
const upstream = git("rev-parse", "--verify", "upstream/main^{commit}");
const head = git("rev-parse", "--verify", "HEAD^{commit}");
const mergeBase = git("merge-base", base, upstream);
const dryRun = spawnSync(
  "git",
  ["merge-tree", "--write-tree", base, upstream],
  {
    encoding: "utf8",
  },
);
if (dryRun.error) throw dryRun.error;
if (dryRun.status !== 0 && dryRun.status !== 1) {
  throw new Error(dryRun.stderr || `merge-tree failed: ${dryRun.status}`);
}

console.log(
  JSON.stringify(
    {
      base,
      upstream,
      head,
      mergeBase,
      upstreamCommitCount: Number(
        git("rev-list", "--count", `${base}..${upstream}`),
      ),
      forkCommitCount: Number(
        git("rev-list", "--count", `${upstream}..${base}`),
      ),
      commits: git("log", "--oneline", `${base}..${head}`)
        .split("\n")
        .filter(Boolean),
      deletedForkFiles: git(
        "diff",
        "--name-only",
        "--diff-filter=D",
        `${upstream}..${head}`,
      )
        .split("\n")
        .filter(Boolean),
      dryRun: {
        conflicts: dryRun.status === 1,
        output: dryRun.stdout.trim(),
      },
    },
    null,
    2,
  ),
);
