import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { releaseInfo } from "../scripts/release-info.mjs";

test("release version must be compatible with Chrome and match both package and tag", () => {
  assert.deepEqual(releaseInfo("2.3.4", "2.3.4", "v2.3.4"), { version: "2.3.4", filename: "subtable-2.3.4.zip" });
  assert.equal(releaseInfo("1.0.0", "1.0.0").version, "1.0.0");
  assert.throws(() => releaseInfo("1.0.0", "1.0.1"), /versions must match/);
  for (const tag of ["v2.0.0", "1.0.0", "v1.0.0-beta", "v1.0.0\nfilename=other.zip"]) {
    assert.throws(() => releaseInfo("1.0.0", "1.0.0", tag), /must match v1.0.0/);
  }
  for (const version of ["../outside", "1.2.3-beta", "01.2.3", "65536.0.0", "0.0.0", undefined]) {
    assert.throws(() => releaseInfo(version, version), /extension version/);
  }
});

test("packager builds a versioned, loadable release ZIP and rejects a mismatched tag", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "subtable-package-"));
  try {
    for (const name of ["extension", "scripts", "package.json"]) {
      await cp(new URL(`../${name}`, import.meta.url), path.join(temp, name), { recursive: true });
    }
    for (const name of ["extension/manifest.json", "package.json"]) {
      const file = path.join(temp, name);
      const content = JSON.parse(await readFile(file, "utf8"));
      content.version = "2.3.4";
      await writeFile(file, JSON.stringify(content));
    }
    const output = path.join(temp, "github-output");
    const env = { ...process.env, RELEASE_TAG: "v2.3.4", GITHUB_OUTPUT: output };
    const build = spawnSync(process.execPath, ["scripts/package.mjs"], { cwd: temp, env, encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    assert.equal(await readFile(output, "utf8"), "version=2.3.4\nfilename=subtable-2.3.4.zip\n");
    const zip = path.join(temp, "dist/subtable-2.3.4.zip");
    const listing = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    const files = listing.stdout.trim().split("\n");
    assert.ok(files.includes("manifest.json"));
    assert.ok(files.includes("src/background.js"));
    assert.ok(files.includes("export.html"));
    assert.ok(files.every((file) => !/^(extension\/|tests\/|scripts\/|\.github\/|package\.json)/.test(file)));
    const manifest = spawnSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" });
    assert.equal(JSON.parse(manifest.stdout).version, "2.3.4");
    await rm(zip);
    const invalid = spawnSync(process.execPath, ["scripts/package.mjs"], { cwd: temp, env: { ...env, RELEASE_TAG: "v9.9.9" }, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /must match v2.3.4/);
    await assert.rejects(readFile(zip), { code: "ENOENT" });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
