/**
 * Node-only instrumentation startup.
 * Isolated from instrumentation.ts so Edge bundle never touches Node modules.
 */

// On Windows, the default console code page is GBK (936), which causes UTF-8
// log output (Chinese characters, etc.) to appear garbled.
// Setting code page 65001 (UTF-8) at startup fixes terminal display.
if (process.platform === "win32") {
  try {
    const { spawnSync } = await import("child_process");
    spawnSync("chcp", ["65001"], { shell: true, stdio: "ignore" });
  } catch {
    // Non-critical; proceed even if chcp is unavailable
  }
}

export {};
