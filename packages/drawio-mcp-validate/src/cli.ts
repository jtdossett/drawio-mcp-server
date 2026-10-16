#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve, basename, extname } from "node:path";

import { createValidator } from "./validate.js";
import { checkOffline } from "./offline.js";
import { extractCatalogue, type ShapeCatalogue } from "./catalogue.js";
import type { Finding, ValidationResult } from "./types.js";

const DIAGRAM_EXTENSIONS = new Set([".drawio", ".xml", ".drawio.xml"]);

type CliOptions = {
  paths: string[];
  json?: string;
  svgDir?: string;
  assetPath?: string;
  catalogue?: string;
  dumpCatalogue?: string;
  offline: boolean;
  strictShapes: boolean;
  quiet: boolean;
  warningsAsErrors: boolean;
};

function showHelp(): never {
  process.stdout.write(`
drawio-validate - headless render-level validation for Draw.io diagrams

Usage: drawio-validate [options] <file|dir>...

Loads each diagram into a real headless Draw.io and reports what breaks:
unresolved shape styles, cells that fail to render, console errors, and
documents Draw.io cannot open at all.

Options:
  --offline            Structural checks only - no browser, milliseconds/file
  --catalogue <path>   Shape catalogue for the offline vocabulary check
  --strict-shapes      With --catalogue, treat an unknown shape as an error
  --dump-catalogue <p> Write a shape catalogue from a real Draw.io, then exit
  --json <path>        Write the full report as JSON
  --svg-dir <dir>      Export each page to SVG in this directory
  --asset-path <dir>   Draw.io asset directory (pin this in CI)
  --warnings-as-errors Treat warnings as failures
  --quiet              Only print failures
  --help, -h           Show this message

Exit code is 1 if any diagram has an error-severity finding.

Run --offline on every generation and the full headless check in CI. The
offline vocabulary check can report a false unknown-shape, because stencils
load lazily and the catalogue cannot be proven complete; the headless check
is the authority, which is why unknown-shape is a warning unless you pass
--strict-shapes.
`);
  process.exit(0);
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    paths: [],
    offline: false,
    strictShapes: false,
    quiet: false,
    warningsAsErrors: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") showHelp();
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--strict-shapes") options.strictShapes = true;
    else if (arg === "--catalogue") options.catalogue = argv[++i];
    else if (arg === "--dump-catalogue") options.dumpCatalogue = argv[++i];
    else if (arg === "--warnings-as-errors") options.warningsAsErrors = true;
    else if (arg === "--json") options.json = argv[++i];
    else if (arg === "--svg-dir") options.svgDir = argv[++i];
    else if (arg === "--asset-path") options.assetPath = argv[++i];
    else if (arg.startsWith("-")) {
      process.stderr.write(`Unknown option: ${arg}\n`);
      process.exit(2);
    } else options.paths.push(arg);
  }

  return options;
}

/** Expand directories into the diagram files they contain, recursively. */
async function collectFiles(paths: readonly string[]): Promise<string[]> {
  const found: string[] = [];

  const walk = async (path: string): Promise<void> => {
    const info = await stat(path);
    if (info.isFile()) {
      found.push(path);
      return;
    }
    if (!info.isDirectory()) return;

    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (DIAGRAM_EXTENSIONS.has(extname(entry.name))) {
        found.push(child);
      }
    }
  };

  for (const path of paths) {
    await walk(resolve(path));
  }

  return found;
}

function formatFinding(finding: Finding): string {
  const location = [
    finding.pageIndex !== undefined
      ? `page ${finding.pageIndex}${finding.pageName ? ` (${finding.pageName})` : ""}`
      : null,
    finding.cellId ? `cell ${finding.cellId}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const prefix = finding.severity === "error" ? "ERROR" : "warn ";
  const suffix = location ? ` [${location}]` : "";
  return `  ${prefix} ${finding.code}: ${finding.message}${suffix}`;
}

async function loadCatalogue(path: string): Promise<Set<string>> {
  const parsed = JSON.parse(await readFile(path, "utf-8")) as ShapeCatalogue;
  return new Set(parsed.shapes ?? []);
}

async function writeSvg(
  dir: string,
  result: ValidationResult,
): Promise<void> {
  if (!result.svg?.length) return;
  await mkdir(dir, { recursive: true });
  const stem = basename(result.name).replace(/\.[^.]+$/, "");
  await Promise.all(
    result.svg.map((svg, index) =>
      writeFile(join(dir, `${stem}.page-${index}.svg`), svg, "utf-8"),
    ),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.dumpCatalogue) {
    const catalogue = await extractCatalogue({
      assetPath: options.assetPath,
      onLog: (message) => process.stderr.write(`${message}\n`),
    });
    await writeFile(
      options.dumpCatalogue,
      JSON.stringify(catalogue, null, 2),
      "utf-8",
    );
    process.stdout.write(
      `wrote ${catalogue.shapes.length} shape names from draw.io ${catalogue.drawioVersion ?? "?"} to ${options.dumpCatalogue}\n`,
    );
    process.exit(0);
  }

  if (options.paths.length === 0) showHelp();

  const files = await collectFiles(options.paths);

  if (files.length === 0) {
    process.stderr.write("No diagram files found.\n");
    process.exit(2);
  }

  const log = (message: string) => {
    if (!options.quiet) process.stderr.write(`${message}\n`);
  };

  const catalogue = options.catalogue
    ? await loadCatalogue(options.catalogue)
    : undefined;

  // --offline never launches a browser, so the validator is only built when
  // the headless pass is actually going to run.
  const validator = options.offline
    ? null
    : await createValidator({
        assetPath: options.assetPath,
        exportSvg: Boolean(options.svgDir),
        onLog: log,
      });

  const results: ValidationResult[] = [];
  let failed = 0;

  try {
    for (const file of files) {
      const xml = await readFile(file, "utf-8");
      const result = validator
        ? await validator.validate({ name: file, xml })
        : await checkOffline(file, xml, {
            catalogue,
            strictShapes: options.strictShapes,
          });
      results.push(result);

      const hasWarnings = result.findings.some((f) => f.severity === "warning");
      const isFailure =
        !result.ok || (options.warningsAsErrors && hasWarnings);
      if (isFailure) failed += 1;

      if (isFailure || !options.quiet) {
        const mark = isFailure ? "FAIL" : "ok  ";
        const summary = `${result.pages.length} page(s), ${result.pages.reduce((n, p) => n + p.vertices + p.edges, 0)} cells, ${result.durationMs}ms`;
        process.stdout.write(`${mark} ${file} - ${summary}\n`);
        for (const finding of result.findings) {
          process.stdout.write(`${formatFinding(finding)}\n`);
        }
      }

      if (options.svgDir) await writeSvg(options.svgDir, result);
    }
  } finally {
    await validator?.close();
  }

  if (options.json) {
    await writeFile(
      options.json,
      JSON.stringify({ results, failed, total: files.length }, null, 2),
      "utf-8",
    );
  }

  process.stdout.write(
    `\n${files.length - failed}/${files.length} diagrams passed\n`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(
    `drawio-validate failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(2);
});
