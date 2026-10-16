import {
  buildEditorUrl,
  isWslEnvironment,
  openInBrowser,
  resolveLaunchCommand,
  type LaunchCommand,
} from "./open-editor.js";
import type { AppLogger } from "./index.js";

const noopLogger: AppLogger = {
  log: () => {},
  debug: () => {},
};

const linux = (env: NodeJS.ProcessEnv = {}) => ({
  platform: "linux" as NodeJS.Platform,
  env,
});

const asCommand = (result: LaunchCommand | Error): LaunchCommand => {
  if (result instanceof Error) {
    throw result;
  }
  return result;
};

describe("buildEditorUrl", () => {
  test("defaults to localhost when no host is configured", () => {
    expect(buildEditorUrl({ scheme: "http", port: 3000 })).toBe(
      "http://localhost:3000/",
    );
  });

  test("keeps an explicit loopback host", () => {
    expect(
      buildEditorUrl({ scheme: "http", host: "127.0.0.1", port: 3000 }),
    ).toBe("http://127.0.0.1:3000/");
  });

  test("rewrites the IPv4 unspecified address to localhost", () => {
    expect(
      buildEditorUrl({ scheme: "http", host: "0.0.0.0", port: 8080 }),
    ).toBe("http://localhost:8080/");
  });

  test("rewrites the IPv6 unspecified address to localhost", () => {
    expect(buildEditorUrl({ scheme: "http", host: "::", port: 8080 })).toBe(
      "http://localhost:8080/",
    );
  });

  test("brackets an IPv6 literal", () => {
    expect(buildEditorUrl({ scheme: "http", host: "::1", port: 3000 })).toBe(
      "http://[::1]:3000/",
    );
  });

  test("does not double-bracket an already bracketed host", () => {
    expect(buildEditorUrl({ scheme: "http", host: "[::1]", port: 3000 })).toBe(
      "http://[::1]:3000/",
    );
  });

  test("uses https when TLS is on", () => {
    expect(buildEditorUrl({ scheme: "https", port: 3000 })).toBe(
      "https://localhost:3000/",
    );
  });
});

describe("isWslEnvironment", () => {
  test("detects WSL_DISTRO_NAME", () => {
    expect(isWslEnvironment({ WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
  });

  test("detects WSL_INTEROP", () => {
    expect(isWslEnvironment({ WSL_INTEROP: "/run/WSL/8_interop" })).toBe(true);
  });

  test("plain Linux is not WSL", () => {
    expect(isWslEnvironment({})).toBe(false);
  });

  test("empty values are not WSL", () => {
    expect(isWslEnvironment({ WSL_DISTRO_NAME: "" })).toBe(false);
  });
});

describe("resolveLaunchCommand", () => {
  const url = "http://localhost:3000/";

  test("macOS uses open", () => {
    expect(
      asCommand(resolveLaunchCommand(url, { platform: "darwin", env: {} })),
    ).toEqual({ command: "open", args: [url] });
  });

  test("Windows uses the cmd start builtin with an empty title", () => {
    expect(
      asCommand(resolveLaunchCommand(url, { platform: "win32", env: {} })),
    ).toEqual({ command: "cmd.exe", args: ["/c", "start", "", url] });
  });

  test("plain Linux uses xdg-open", () => {
    expect(asCommand(resolveLaunchCommand(url, linux()))).toEqual({
      command: "xdg-open",
      args: [url],
    });
  });

  test("WSL prefers wslview when it is installed", () => {
    const result = asCommand(
      resolveLaunchCommand(
        url,
        linux({ WSL_DISTRO_NAME: "Ubuntu" }),
        (command) => command === "wslview",
      ),
    );
    expect(result).toEqual({ command: "wslview", args: [url] });
  });

  test("WSL falls back to Windows start when wslview is missing", () => {
    const result = asCommand(
      resolveLaunchCommand(
        url,
        linux({ WSL_DISTRO_NAME: "Ubuntu" }),
        () => false,
      ),
    );
    expect(result).toEqual({
      command: "cmd.exe",
      args: ["/c", "start", "", url],
    });
  });

  test("$BROWSER wins over the platform default", () => {
    expect(
      asCommand(resolveLaunchCommand(url, linux({ BROWSER: "firefox" }))),
    ).toEqual({ command: "firefox", args: [url] });
  });

  test("blank $BROWSER is ignored", () => {
    expect(
      asCommand(resolveLaunchCommand(url, linux({ BROWSER: "   " }))),
    ).toEqual({ command: "xdg-open", args: [url] });
  });

  test("rejects a non-http scheme", () => {
    expect(resolveLaunchCommand("file:///etc/passwd", linux())).toBeInstanceOf(
      Error,
    );
  });

  test("rejects a URL carrying shell metacharacters", () => {
    expect(
      resolveLaunchCommand("http://localhost:3000/;rm -rf /", linux()),
    ).toBeInstanceOf(Error);
  });

  test("accepts the query string the editor redirect uses", () => {
    const editorUrl = "http://localhost:3000/index.html?offline=1&local=1";
    expect(asCommand(resolveLaunchCommand(editorUrl, linux()))).toEqual({
      command: "xdg-open",
      args: [editorUrl],
    });
  });
});

describe("openInBrowser", () => {
  test("resolves to null after a successful spawn", async () => {
    const result = await openInBrowser(
      "http://localhost:3000/",
      noopLogger,
      linux({ BROWSER: "/bin/true" }),
    );
    expect(result).toBeNull();
  });

  test("returns an Error when the opener is not installed", async () => {
    const result = await openInBrowser(
      "http://localhost:3000/",
      noopLogger,
      linux({ BROWSER: "/nonexistent/browser-binary" }),
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("browser-binary");
  });

  test("returns the validation Error without spawning", async () => {
    const result = await openInBrowser(
      "javascript:alert(1)",
      noopLogger,
      linux({ BROWSER: "/bin/true" }),
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("unsafe URL");
  });
});
