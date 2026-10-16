import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { checkOffline } from "./offline.js";
import type { ShapeCatalogue } from "./catalogue.js";
import type { Finding } from "./types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

const catalogue = new Set(
  (
    JSON.parse(
      await readFile(join(FIXTURES, "catalogue.json"), "utf-8"),
    ) as ShapeCatalogue
  ).shapes,
);

const run = async (fixture: string, strictShapes = false) =>
  checkOffline(
    fixture,
    await readFile(join(FIXTURES, fixture), "utf-8"),
    { catalogue, strictShapes },
  );

const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);

describe("offline checks", () => {
  test("a valid diagram produces no findings", async () => {
    const result = await run("good.drawio");
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
    assert.equal(result.pages[0]?.vertices, 2);
    assert.equal(result.pages[0]?.edges, 1);
  });

  test("reports structural defects with cell ids", async () => {
    const result = await run("structural.drawio");
    assert.equal(result.ok, false);

    const found = codes(result.findings);
    assert.ok(found.includes("duplicate-cell-id"));
    assert.ok(found.includes("missing-parent"));
    assert.ok(found.includes("dangling-edge"));
    assert.ok(found.includes("degenerate-geometry"));

    const dangling = result.findings.find((f) => f.code === "dangling-edge");
    assert.equal(dangling?.cellId, "edge1");
  });

  test("rejects a file that is not Draw.io XML", async () => {
    const result = await run("malformed.drawio");
    assert.equal(result.ok, false);
    assert.ok(codes(result.findings).includes("malformed-xml"));
  });

  test("reads Draw.io's compressed diagram payloads", async () => {
    const result = await run("compressed.drawio");
    // Without inflate support this would read as an empty document.
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0]?.vertices, 1);
    assert.ok(codes(result.findings).includes("unknown-shape"));
  });

  test("flags an unknown shape as a warning by default", async () => {
    const result = await run("typo-shape.drawio");
    const finding = result.findings.find((f) => f.code === "unknown-shape");
    assert.equal(finding?.severity, "warning");
    // A warning alone must not fail the run: the catalogue cannot be proven
    // complete, so the headless check stays the authority.
    assert.equal(result.ok, true);
  });

  test("--strict-shapes escalates an unknown shape to an error", async () => {
    const result = await run("typo-shape.drawio", true);
    const finding = result.findings.find((f) => f.code === "unknown-shape");
    assert.equal(finding?.severity, "error");
    assert.equal(result.ok, false);
  });

  test("catches a typo in a stencil-valued key", async () => {
    const result = await run("bad-resicon.drawio");
    const findings = result.findings.filter((f) => f.code === "unknown-shape");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.cellId, "badicon");
    assert.equal(findings[0]?.shape, "mxgraph.aws4.lamdba_funtcion");
  });

  test("attributes findings to the right page of a multi-page file", async () => {
    const result = await run("two-pages.drawio");
    assert.equal(result.pages.length, 2);

    const finding = result.findings.find((f) => f.code === "unknown-shape");
    assert.equal(finding?.pageIndex, 1);
    assert.equal(finding?.pageName, "Second");
  });

  test("skips the vocabulary check when no catalogue is given", async () => {
    const result = await checkOffline(
      "typo-shape.drawio",
      await readFile(join(FIXTURES, "typo-shape.drawio"), "utf-8"),
    );
    assert.deepEqual(codes(result.findings), []);
  });
});
