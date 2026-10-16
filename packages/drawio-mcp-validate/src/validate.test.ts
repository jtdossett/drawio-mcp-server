import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createValidator, type Validator } from "./validate.js";
import type { ValidationResult } from "./types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

// Booting Draw.io in a headless browser is slow; every test shares one.
const BOOT_TIMEOUT_MS = 180_000;

describe("validator", { timeout: BOOT_TIMEOUT_MS }, () => {
  let validator: Validator;

  const run = async (fixture: string): Promise<ValidationResult> => {
    const path = join(FIXTURES, fixture);
    return validator.validate({
      name: fixture,
      xml: await readFile(path, "utf-8"),
    });
  };

  before(async () => {
    validator = await createValidator();
  });

  after(async () => {
    await validator?.close();
  });

  test("accepts a diagram whose shapes all resolve", async () => {
    const result = await run("good.drawio");
    assert.deepEqual(
      result.findings.filter((f) => f.severity === "error"),
      [],
    );
    assert.equal(result.ok, true);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0]?.vertices, 2);
    assert.equal(result.pages[0]?.edges, 1);
  });

  test("rejects a document Draw.io cannot parse", async () => {
    const result = await run("malformed.drawio");
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.code === "import-failed"));
  });

  test("pinpoints an unresolved shape style by cell id", async () => {
    const result = await run("typo-shape.drawio");
    assert.equal(result.ok, false);

    const finding = result.findings.find((f) => f.code === "unresolved-shape");
    assert.ok(finding, "expected an unresolved-shape finding");
    assert.equal(finding.cellId, "typo");
    assert.equal(finding.shape, "mxgraph.aws4.lambda_functionnn");
  });

  test("catches a typo in a stencil-valued key, not just shape=", async () => {
    const result = await run("bad-resicon.drawio");
    assert.equal(result.ok, false);

    const findings = result.findings.filter(
      (f) => f.code === "unresolved-shape",
    );
    // The host shape (mxgraph.aws4.resourceIcon) resolves fine on both cells;
    // only the typo'd icon on `badicon` should be reported.
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.cellId, "badicon");
    assert.equal(findings[0]?.styleKey, "resIcon");
    assert.equal(findings[0]?.shape, "mxgraph.aws4.lamdba_funtcion");
  });

  test("checks every page, not just the first", async () => {
    const result = await run("two-pages.drawio");
    assert.equal(result.pages.length, 2);

    // The bad shape is on the second page; a single-page check would miss it.
    const finding = result.findings.find((f) => f.code === "unresolved-shape");
    assert.ok(finding, "expected an unresolved-shape finding");
    assert.equal(finding.pageIndex, 1);
    assert.equal(finding.pageName, "Second");
  });

  test("findings do not leak between consecutive diagrams", async () => {
    await run("typo-shape.drawio");
    const result = await run("good.drawio");
    assert.deepEqual(
      result.findings.filter((f) => f.severity === "error"),
      [],
    );
  });
});
