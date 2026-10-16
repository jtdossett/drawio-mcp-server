import { spawn } from "node:child_process";

import type { AppLogger } from "./index.js";

/**
 * How the server should get a Draw.io client in front of the user.
 *
 * - `off`    — do nothing; the user opens the editor URL themselves.
 * - `browser`— hand the editor URL to the OS default browser and let the
 *              injected MCP plugin connect back over the WebSocket port.
 */
export type OpenMode = "off" | "browser";

export const OPEN_MODES: readonly OpenMode[] = ["off", "browser"] as const;

/**
 * How long startup waits for the browser we just launched to boot Draw.io
 * and register a document. Generous: a cold browser start plus the draw.io
 * webapp parse is slow on first run.
 */
export const EDITOR_CONNECT_TIMEOUT_MS = 30_000;

/**
 * How long a tool call waits for that same connection before giving up. The
 * caller is already blocked on a response here, so this is tighter than the
 * startup budget.
 */
export const EDITOR_CONNECT_GRACE_MS = 20_000;

export interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface LaunchEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Addresses that mean "every interface". They are valid bind targets but not
 * valid things to point a browser at, so the editor URL falls back to
 * loopback when the server is bound to one of them.
 */
const UNSPECIFIED_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * The editor URL is assembled from our own config (scheme, host, port) rather
 * than from user free-text, but it still crosses a process boundary into
 * `cmd.exe` on Windows/WSL. Validating it here keeps shell metacharacters out
 * of that hand-off regardless of how the URL was built.
 */
const SAFE_URL =
  /^https?:\/\/[A-Za-z0-9._~\-[\]%]+(:\d+)?(\/[A-Za-z0-9._~\-/?=&%#]*)?$/;

/**
 * Detect WSL from the environment alone - pure function.
 *
 * Both variables are injected by the WSL interop layer; checking env (rather
 * than sniffing /proc/version) keeps this testable and synchronous.
 */
export const isWslEnvironment = (env: NodeJS.ProcessEnv): boolean => {
  return Boolean(env.WSL_DISTRO_NAME?.length || env.WSL_INTEROP?.length);
};

/**
 * Build the URL a browser should open to reach the built-in editor - pure
 * function.
 */
export const buildEditorUrl = (options: {
  readonly scheme: "http" | "https";
  readonly host?: string;
  readonly port: number;
}): string => {
  const { scheme, host, port } = options;
  const rawHost = host && host.length > 0 ? host : "localhost";
  const browsableHost = UNSPECIFIED_HOSTS.has(rawHost) ? "localhost" : rawHost;

  // IPv6 literals need brackets in a URL authority; a host that already
  // carries them (or is a name / IPv4) is passed through untouched.
  const authority =
    browsableHost.includes(":") && !browsableHost.startsWith("[")
      ? `[${browsableHost}]`
      : browsableHost;

  return `${scheme}://${authority}:${port}/`;
};

/**
 * Resolve the platform-specific command that opens `url` in the user's
 * default browser - pure function.
 *
 * Precedence:
 *   1. `$BROWSER` (freedesktop convention; honoured on every platform)
 *   2. WSL interop — `wslview` if the distro has wslu, else Windows `start`
 *   3. Native per-platform opener
 */
export const resolveLaunchCommand = (
  url: string,
  environment: LaunchEnvironment,
  hasCommand: (command: string) => boolean = () => false,
): LaunchCommand | Error => {
  if (!SAFE_URL.test(url)) {
    return new Error(
      `Refusing to open unsafe URL "${url}". Only plain http(s) URLs are supported.`,
    );
  }

  const { platform, env } = environment;

  const browserOverride = env.BROWSER?.trim();
  if (browserOverride && browserOverride.length > 0) {
    return { command: browserOverride, args: [url] };
  }

  if (platform === "win32") {
    // `start` is a cmd.exe builtin, not an executable. The empty string is
    // the window title argument - without it, a quoted URL would be eaten
    // as the title.
    return { command: "cmd.exe", args: ["/c", "start", "", url] };
  }

  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (platform === "linux" && isWslEnvironment(env)) {
    // Inside WSL the useful browser is the Windows one: a Linux xdg-open
    // typically has no graphical browser to hand off to.
    if (hasCommand("wslview")) {
      return { command: "wslview", args: [url] };
    }
    return { command: "cmd.exe", args: ["/c", "start", "", url] };
  }

  return { command: "xdg-open", args: [url] };
};

/**
 * Spawn the resolved opener and detach from it.
 *
 * Resolves to `null` on a successful spawn, or an `Error` describing why the
 * browser could not be launched. Callers treat failure as non-fatal: the
 * server stays up and the user can open the URL by hand.
 */
export const openInBrowser = async (
  url: string,
  log: AppLogger,
  environment: LaunchEnvironment = {
    platform: process.platform,
    env: process.env,
  },
  hasCommand?: (command: string) => boolean,
): Promise<Error | null> => {
  const resolved = resolveLaunchCommand(url, environment, hasCommand);

  if (resolved instanceof Error) {
    return resolved;
  }

  log.debug(
    `[open] launching browser: ${resolved.command} ${resolved.args.join(" ")}`,
  );

  return new Promise<Error | null>((resolve) => {
    let settled = false;
    const finish = (result: Error | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const child = spawn(resolved.command, [...resolved.args], {
        // `ignore` is load-bearing, not tidiness: under the stdio transport
        // the browser would otherwise inherit our stdout and any banner it
        // prints would corrupt the JSON-RPC frame stream.
        stdio: "ignore",
        detached: true,
      });

      child.once("error", (error: Error) => {
        finish(
          new Error(`Failed to run "${resolved.command}": ${error.message}`),
        );
      });

      child.once("spawn", () => {
        // Let the browser outlive us, and stop it pinning our event loop.
        child.unref();
        finish(null);
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
};
