import { copyFileSync, mkdirSync, rmSync } from "node:fs";

const outputDirectory = new URL("../dist/", import.meta.url);
const projectFiles = ["index.html", "styles.css", "app.js", "security.js", "tour.js"];

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

for (const file of projectFiles) {
  copyFileSync(new URL(`../${file}`, import.meta.url), new URL(file, outputDirectory));
}

console.log(`Built ${projectFiles.length} static files in dist/`);
