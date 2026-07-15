import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const distDir = path.join(rootDir, "dist");

const listFiles = async (directory, prefix = "") => {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(directory, entry.name), relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
};

const files = await listFiles(distDir);
const javaScriptAssets = files.filter((file) =>
  /^ui\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(file),
);
const cssAssets = files.filter((file) => /^ui\/assets\/index-[A-Za-z0-9_-]+\.css$/.test(file));
const expectedFiles = new Set(["cli.js", "ui/index.html", ...javaScriptAssets, ...cssAssets]);

if (
  javaScriptAssets.length !== 1 ||
  cssAssets.length !== 1 ||
  files.length !== expectedFiles.size ||
  files.some((file) => !expectedFiles.has(file))
) {
  throw new Error(
    `Unexpected release assets. Expected cli.js, ui/index.html, and one hashed JS and CSS asset; found: ${files.join(", ")}`,
  );
}

const html = await readFile(path.join(distDir, "ui/index.html"), "utf8");
for (const asset of [...javaScriptAssets, ...cssAssets]) {
  const publicPath = `/${asset.slice("ui/".length)}`;
  if (!html.includes(publicPath)) {
    throw new Error(`ui/index.html does not reference ${publicPath}`);
  }
}

const javaScript = await readFile(path.join(distDir, javaScriptAssets[0]), "utf8");
const releaseText = `${html}\n${javaScript}`;
const forbiddenMarkers = [
  "9988",
  "foldkit:devTools:event",
  "foldkit:devTools:request",
  "vite:beforeFullReload",
  "No response from @foldkit/vite-plugin",
  "/@vite/client",
  "virtual:stylex:runtime",
  "/src/entry.ts",
];
const foundMarkers = forbiddenMarkers.filter((marker) => releaseText.includes(marker));

if (foundMarkers.length > 0) {
  throw new Error(`Release UI contains development-only markers: ${foundMarkers.join(", ")}`);
}

const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const productionDependencies = packageJson.dependencies ?? {};
const browserOnlyDependencies = [
  "@effect/platform-browser",
  "foldkit",
  "@foldkit/devtools-mcp",
  "@foldkit/vite-plugin",
  "vite",
].filter((dependency) => Object.hasOwn(productionDependencies, dependency));

if (browserOnlyDependencies.length > 0) {
  throw new Error(
    `Browser-only build dependencies must not be published as runtime dependencies: ${browserOnlyDependencies.join(", ")}`,
  );
}

console.log(`Release assets verified: ${files.join(", ")}`);
