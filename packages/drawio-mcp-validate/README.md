# drawio-mcp-validate

Render-level validation for generated Draw.io diagrams.

Meant for repositories that generate `.drawio` files deterministically from
templates or code, where the diagram is a build artifact and nobody is going
to open all of them by hand.

It runs in two modes:

| Mode | Cost | Use it |
|---|---|---|
| `--offline` | ~1ms/file, no browser | On every generation, and as a pre-commit hook |
| default | ~0.6s/file after a one-off boot | In CI |

The offline mode does structural checks and an optional shape-vocabulary
check. The default mode loads each diagram into a real, headless Draw.io,
which is the only way to answer "does this actually render".

## Why a browser

Checking generated Draw.io XML with an XML parser catches malformed files and
nothing else. The failure that actually matters looks like this:

```xml
<mxCell id="fn" style="shape=mxgraph.aws4.lambda_functionnn;" vertex="1" ... />
```

That style resolves to nothing. Draw.io does not raise an error — it silently
falls back to a plain rectangle, so the diagram renders, looks roughly
plausible at a glance, and is wrong. The only reliable way to detect it is to
ask a real Draw.io whether the shape resolved.

## Install

```sh
pnpm add -D drawio-mcp-validate
pnpm exec playwright install chromium
```

## CLI

```sh
drawio-validate diagrams/
drawio-validate diagrams/architecture.drawio --svg-dir out/svg
drawio-validate diagrams/ --json report.json --quiet
```

Directories are walked recursively for `.drawio` and `.xml` files. Exit code
is 1 if any diagram has an error-severity finding, so it drops into CI as-is.

| Option | Effect |
|---|---|
| `--offline` | Structural checks only, no browser |
| `--catalogue <path>` | Shape catalogue for the offline vocabulary check |
| `--strict-shapes` | With `--catalogue`, make an unknown shape an error |
| `--dump-catalogue <path>` | Write a catalogue from a real Draw.io, then exit |
| `--json <path>` | Write the full report as JSON |
| `--svg-dir <dir>` | Export every page to SVG (`<name>.page-<n>.svg`) |
| `--asset-path <dir>` | Draw.io asset directory — **pin this in CI**, see below |
| `--warnings-as-errors` | Treat warnings as failures |
| `--quiet` | Only print failures |

Sample output:

```
ok   diagrams/good.drawio - 1 page(s), 3 cells, 636ms
FAIL diagrams/broken.drawio - 2 page(s), 2 cells, 862ms
  ERROR unresolved-shape: Shape "mxgraph.nonsense.widget" is not a registered
        shape or stencil; Draw.io rendered a plain mxRectangleShape instead
        [page 1 (Second), cell y]
```

## Library

Booting Draw.io takes a few seconds; validating a diagram afterwards takes
well under one. Create one validator and reuse it for the whole run.

```ts
import { createValidator } from "drawio-mcp-validate";

const validator = await createValidator();
try {
  for (const file of files) {
    const result = await validator.validate({
      name: file,
      xml: await readFile(file, "utf-8"),
    });
    if (!result.ok) report(result.findings);
  }
} finally {
  await validator.close();
}
```

`validateAll(inputs, options)` wraps that loop when you do not need to
interleave anything.

## The shape catalogue

Generate it once from a real Draw.io and commit it:

```sh
drawio-validate --dump-catalogue shapes.json
# wrote 3035 shape names from draw.io 32.4.1 to shapes.json
```

Then the offline check can verify every shape name without a browser:

```sh
drawio-validate --offline --catalogue shapes.json diagrams/
```

Regenerate it when you move Draw.io versions. The catalogue merges the shapes
registered in the Draw.io runtime with every shape the vendor palettes offer,
so it covers both `shape=mxgraph.aws4.resourceIcon` and the
`resIcon=mxgraph.aws4.lambda` that names the icon.

It still cannot be *proven* complete, because stencils load lazily and a valid
stencil that no palette offers would be missing. That is why `unknown-shape`
is a warning by default — the headless check is the authority. Pass
`--strict-shapes` once you have confirmed your diagrams are clean.

## What it checks

Headless mode:

| Code | Severity | Meaning |
|---|---|---|
| `import-failed` | error | Draw.io could not open the document at all |
| `unresolved-shape` | error | A style reference matched no shape or stencil |
| `render-failed` | error | A cell is in the model but produced no view state |
| `browser-error` | error | Draw.io logged a console error or threw while rendering |
| `export-failed` | error | SVG export of a page failed |
| `empty-page` | warning | A page contains no cells |

Offline mode (`--offline`):

| Code | Severity | Meaning |
|---|---|---|
| `malformed-xml` | error | Not parseable as a Draw.io file |
| `duplicate-cell-id` | error | The same cell id appears twice |
| `dangling-edge` | error | An edge endpoint names a cell that does not exist |
| `missing-parent` | error | A cell's parent names a cell that does not exist |
| `unknown-shape` | warning | A shape name is absent from the catalogue |
| `degenerate-geometry` | warning | A vertex has zero or negative width/height |
| `empty-page` | warning | A page contains no cells |

Both modes check every page of a multi-page `<mxfile>`, not just the first,
read Draw.io's compressed diagram payloads, and carry the page index, page
name and cell id on every finding.

`unresolved-shape` and `unknown-shape` check more than `shape=`. Vendor
palettes put the actual icon in a second style key — `resIcon`, `prIcon` and
friends — whose value is a separate stencil name. A typo there leaves the host
shape resolving perfectly well and is the most likely mistake in a generated
AWS/Azure/GCP diagram, so any style value in the `mxgraph.` namespace is
checked.

A note on `browser-error`: an unresolved stencil often also produces a generic
`404 (Not Found)` console error, so one bad shape can yield two findings. The
check is kept because a 404 also catches genuinely separate defects, such as a
diagram referencing an image URL that does not exist.

## Pinning Draw.io in CI

The draw.io webapp is downloaded from the `jgraph/drawio` **latest** release
and cached, and the cache is only refreshed when the cached version falls
outside the server's supported range. Which version you get therefore depends
on when the cache was first populated — a cold CI runner gets whatever shipped
today, your laptop has whatever it had in October.

That is fine for pass/fail checks and poison for comparing exported SVG
against committed goldens. Bake a fixed asset directory into your CI image and
point `--asset-path` at it:

```sh
# once, at image build time
npx drawio-mcp-server --asset-path /opt/drawio-assets --help >/dev/null
# then, in CI
drawio-validate diagrams/ --asset-path /opt/drawio-assets
```

## Suggested setup

```sh
# fast, on every generation
drawio-validate --offline --catalogue shapes.json diagrams/

# authoritative, in CI
drawio-validate diagrams/ --asset-path /opt/drawio-assets --json report.json
```

Keep the validation contract in committed test code rather than having an
agent judge its own generated output — otherwise there is no independent
check, and a diagram that renders as a grid of blank boxes looks fine at a
glance.
