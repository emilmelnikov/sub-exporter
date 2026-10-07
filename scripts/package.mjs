import { mkdir, rm, readFile, appendFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { releaseInfo } from "./release-info.mjs";
const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const { version, filename } = releaseInfo(manifest.version, pkg.version, process.env.RELEASE_TAG);
await import("./check.mjs");
const destination = new URL("../dist/", import.meta.url);
await mkdir(destination, { recursive: true });
const zip = new URL(filename, destination);
await rm(zip, { force: true });
const result = spawnSync("zip", ["-qr", fileURLToPath(zip), ".", "-x", "*.DS_Store"], { cwd: fileURLToPath(new URL("../extension/", import.meta.url)), stdio: "inherit" });
if (result.status !== 0) throw new Error("Could not create ZIP; install the zip utility or zip the extension directory manually.");
console.log(`Packaged ${fileURLToPath(zip)}`);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\nfilename=${filename}\n`);
}
