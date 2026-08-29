import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { capture, run } from "./lib/process.mjs";
import { repoRoot } from "./lib/config.mjs";

const git = "/usr/bin/git";
const tar = "/usr/bin/tar";
const scratch = await mkdtemp(path.join(os.tmpdir(), "grok-bot-publication-"));
const archive = path.join(scratch, "repository.tar");
const exported = path.join(scratch, "exported");

const gitNoLfs = [
  "-c", "filter.lfs.smudge=",
  "-c", "filter.lfs.clean=",
  "-c", "filter.lfs.process=",
  "-c", "filter.lfs.required=false",
  "-c", "core.autocrlf=false",
  "-c", "core.excludesFile=/dev/null",
];

const gitEnv = {
  ...process.env,
  GIT_LFS_SKIP_SMUDGE: "1",
};

try {
  await run(git, [...gitNoLfs, "archive", "--format=tar", `--output=${archive}`, "HEAD"], {
    cwd: repoRoot,
    env: gitEnv,
  });
  await mkdir(exported);
  await run(tar, ["-xpf", archive, "-C", exported]);
  await run(git, [...gitNoLfs, "init", "--quiet"], { cwd: exported, env: gitEnv });
  // Tracked files may still match .gitignore (Android www stub). Force-add the
  // archived tree so a clean export round-trips HEAD. LFS filters stay off so
  // GitHub runners do not rewrite pointer files.
  await run(git, [...gitNoLfs, "add", "-f", "--all"], { cwd: exported, env: gitEnv });

  const [sourceTree, exportedTree, sourceFiles, exportedFiles] = await Promise.all([
    capture(git, [...gitNoLfs, "rev-parse", "HEAD^{tree}"], { cwd: repoRoot, env: gitEnv }),
    capture(git, [...gitNoLfs, "write-tree"], { cwd: exported, env: gitEnv }),
    capture(git, [...gitNoLfs, "ls-tree", "-r", "--name-only", "HEAD"], { cwd: repoRoot, env: gitEnv }),
    capture(git, [...gitNoLfs, "ls-files"], { cwd: exported, env: gitEnv }),
  ]);
  if (sourceTree !== exportedTree) {
    const sourceSet = new Set(sourceFiles.split("\n").filter(Boolean));
    const exportedSet = new Set(exportedFiles.split("\n").filter(Boolean));
    const omitted = [...sourceSet].filter(file => !exportedSet.has(file)).sort();
    const unexpected = [...exportedSet].filter(file => !sourceSet.has(file)).sort();
    throw new Error(`Fresh publication export changed the tracked tree. Omitted (${omitted.length}): ${omitted.slice(0, 20).join(", ") || "none"}. Unexpected (${unexpected.length}): ${unexpected.slice(0, 20).join(", ") || "none"}.`);
  }

  const ignoredSource = "frontend/src/recovered/ui/sand-form-primitives.css";
  if (!(await readFile(path.join(exported, ignoredSource))).byteLength) {
    throw new Error(`Fresh publication export omitted ${ignoredSource}`);
  }
  console.log(`Publication export preserves ${sourceFiles.split("\n").filter(Boolean).length} files and tree ${sourceTree}.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
