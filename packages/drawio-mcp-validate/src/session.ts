import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createDrawioMcpApp } from "drawio-mcp-server/build/index.js";
import type { DrawioMcpApp } from "drawio-mcp-server/build/index.js";
import {
  defaultConfig,
  getHttpFeatureConfig,
  type ServerConfig,
} from "drawio-mcp-server/build/config.js";
import { ensureAssets } from "drawio-mcp-server/build/assets/index.js";

export type BrowserMessage = { type: string; text: string };

/**
 * One booted Draw.io: an MCP app serving the self-hosted editor, a headless
 * Chromium on that editor, and an in-memory MCP client wired to the app.
 *
 * Starting this costs several seconds, so a validation run creates exactly
 * one and feeds every diagram through it.
 */
export type ValidationSession = {
  readonly client: Client;
  readonly page: Page;
  readonly messages: BrowserMessage[];
  close: () => Promise<void>;
};

const silent = {
  log: () => {},
  debug: () => {},
};

export async function createValidationSession(options: {
  assetPath?: string;
  onLog?: (message: string) => void;
}): Promise<ValidationSession> {
  const log = options.onLog ?? (() => {});

  log("preparing draw.io assets");
  await ensureAssets({ assetPath: options.assetPath }, silent);

  const app: DrawioMcpApp = createDrawioMcpApp({
    config: defaultConfig(),
    log: silent,
  });

  // Port 0 throughout: a validation run must never collide with a dev server
  // or with a second validator running in the same CI job.
  const wsServer = await app.startWebSocketServer(0, "127.0.0.1");
  const wsPort = Number((wsServer.address() as { port: number }).port);

  const config: ServerConfig = {
    ...defaultConfig(),
    extensionPort: wsPort,
    httpPort: 0,
    transports: ["http"],
    editorEnabled: true,
    assetPath: options.assetPath,
    host: "127.0.0.1",
  };

  const http = await app.startHttpServer(0, config, getHttpFeatureConfig(config));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "drawio-mcp-validate", version: "0.1.0" });
  const mcpServer = app.createMcpServer();
  await Promise.all([
    mcpServer.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  log("launching headless chromium");
  const browser: Browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();

  const messages: BrowserMessage[] = [];
  page.on("console", (message) => {
    messages.push({ type: message.type(), text: message.text() });
  });
  // An uncaught exception never reaches page.on("console"), so it needs its
  // own channel or a hard render failure looks like a clean run.
  page.on("pageerror", (error) => {
    messages.push({ type: "error", text: `uncaught: ${error.message}` });
  });

  // Two things have to be in place before the editor boots:
  //
  // 1. The plugin reads its WebSocket port from localStorage. The editor
  //    would otherwise derive it from the page origin, which is the HTTP
  //    port, not the (separate, OS-assigned) WebSocket one.
  // 2. `__DRAWIO_MCP_TEST_HOOKS__` makes the plugin publish the Draw.io UI
  //    object as `window.ui` (see plugin.ts). Without it the UI stays
  //    private and none of the model inspection below can reach the graph.
  await page.addInitScript((port: number) => {
    const store = JSON.stringify({ websocketPort: port });
    window.localStorage.setItem("drawio-mcp-plugin-config", store);
    window.localStorage.setItem("drawio-mcp-config", store);
    (window as unknown as Record<string, unknown>).__DRAWIO_MCP_TEST_HOOKS__ =
      true;
  }, wsPort);

  await page.goto(`http://127.0.0.1:${http.port}/`, {
    waitUntil: "domcontentloaded",
  });
  await waitForEditorReady(page);
  log("draw.io ready");

  return {
    client,
    page,
    messages,
    close: async () => {
      await client.close().catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      await app.close().catch(() => {});
    },
  };
}

async function waitForEditorReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const ui = (window as any).ui;
    return Boolean(ui?.editor?.graph?.getModel?.()?.cells);
  });
  await page.waitForFunction(() => document.querySelector("svg") !== null);
}
