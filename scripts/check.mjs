import { readdir, readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const root = new URL("../extension/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Manifest must be V3");
for (const file of [manifest.background.service_worker, "export.html", "styles.css", ...Object.values(manifest.icons), ...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? [])]) await access(new URL(file, root));
for (const file of await readdir(new URL("src/", root))) {
  if (!file.endsWith(".js")) continue;
  const full = new URL(`src/${file}`, root);
  const checked = spawnSync(process.execPath, ["--check", full.pathname], { encoding: "utf8" });
  if (checked.status) throw new Error(checked.stderr);
  const source = await readFile(full, "utf8");
  for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) await access(new URL(match[1], full));
}
const html = await readFile(new URL("export.html", root), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
if (new Set(ids).size !== ids.length) throw new Error("Duplicate UI ID");
const app = await readFile(new URL("src/app.js", root), "utf8");
for (const match of app.matchAll(/\$\("([^"]+)"\)/g)) if (!ids.includes(match[1])) throw new Error(`Missing UI element ${match[1]}`);
console.log(`Manifest V3, resources, module imports, JavaScript syntax and ${ids.length} UI IDs verified.`);
