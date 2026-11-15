// Сборка расширения в папку dist/ (её и нужно загружать в Chrome).
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
cpSync("static", "dist", { recursive: true });

const options = {
  entryPoints: {
    background: "src/background.js",
    content: "src/content.js",
    "page-hook": "src/page-hook.js",
    options: "src/options.js",
  },
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome120",
  logLevel: "info",
  minify: !watch,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}

// Тот же рендер (формулы, рисунки) для окна-компаньона.
const companionOptions = {
  entryPoints: ["src/companion-render.js"],
  outfile: "companion/render.js",
  bundle: true,
  format: "iife",
  target: "chrome120",
  logLevel: "info",
  minify: !watch,
};
if (watch) await (await esbuild.context(companionOptions)).watch();
else await esbuild.build(companionOptions);
