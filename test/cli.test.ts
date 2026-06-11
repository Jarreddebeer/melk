/**
 * CLI integration tests — the exact surface an LLM agent drives, which
 * had zero coverage. Spawns the CLI as a subprocess (the same way an
 * agent does) and checks: validate exit codes + clean diagnostic shape,
 * the default-output-path derivation, the v0.1.3 overwrite-safety guard,
 * E_FILE_NOT_FOUND, and that render no longer dumps a stack trace.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(__dirname, "../src/cli.ts");

/** Run `tsx src/cli.ts <args>`; return { status, stdout, stderr }. */
function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("npx", ["tsx", CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "melk-cli-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("melk validate", () => {
  it("prints OK and exits 0 on a valid file", () => {
    const f = join(dir, "ok.melk");
    writeFileSync(f, "pipeline main: a -> b -> c\n");
    const r = run(["validate", f]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("OK");
  });

  it("prints a clean [stage] E_CODE line and exits 1 on error (no stack trace)", () => {
    const f = join(dir, "bad.melk");
    writeFileSync(f, "a -> a\n"); // self-edge
    const r = run(["validate", f]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[bind\] E_SELF_EDGE/);
    expect(r.stderr).not.toMatch(/at \w+ \(node:/); // no Node stack frames
  });

  it("reports a missing file as E_FILE_NOT_FOUND, not a raw ENOENT stack", () => {
    const r = run(["validate", join(dir, "does-not-exist.melk")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("E_FILE_NOT_FOUND");
    expect(r.stderr).not.toMatch(/readFileSync/);
  });
});

describe("melk render", () => {
  it("defaults -o to <input>.svg next to the input", () => {
    const f = join(dir, "diagram.melk");
    writeFileSync(f, "pipeline main: a -> b\n");
    const r = run(["render", f]);
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, "diagram.svg"))).toBe(true);
    expect(readFileSync(join(dir, "diagram.svg"), "utf8")).toContain("<svg");
  });

  it("does not overwrite the source when -o resolves to the input", () => {
    const f = join(dir, "guard.melk");
    const original = "pipeline main: a -> b\n";
    writeFileSync(f, original);
    run(["render", f, "-o", f]);
    // The contract: the source is never clobbered, and the render lands
    // at <input>.svg instead. (The warning text is incidental.)
    expect(readFileSync(f, "utf8")).toBe(original);
    expect(existsSync(`${f}.svg`)).toBe(true);
  });

  it("prints a clean diagnostic (not a stack trace) on a routing error", () => {
    const f = join(dir, "amb.melk");
    writeFileSync(f, "pipeline m: a -> b -> c\nb -> side\n");
    const r = run(["render", f]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("E_AMBIGUOUS_PLACEMENT");
    expect(r.stderr).not.toMatch(/at \w+ \(node:/);
  });
});
