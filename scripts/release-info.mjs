export function releaseInfo(manifestVersion, packageVersion, tag = "") {
  // Use a version supported by both npm and Chrome's numeric manifest format.
  if (typeof manifestVersion !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifestVersion) ||
      manifestVersion.split(".").some((part) => Number(part) > 65535) || manifestVersion === "0.0.0") {
    throw new Error("The extension version must be X.Y.Z, with components from 0 to 65535, and cannot be 0.0.0.");
  }
  if (packageVersion !== manifestVersion) throw new Error("package.json and extension/manifest.json versions must match.");
  if (tag && tag !== `v${manifestVersion}`) throw new Error(`Release tag ${tag} must match v${manifestVersion}.`);
  return { version: manifestVersion, filename: `subtable-${manifestVersion}.zip` };
}
