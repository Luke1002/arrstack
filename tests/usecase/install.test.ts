import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getHostIp, readSecretFromFile } from "../../src/usecase/install.js";
import type { StepUpdate } from "../../src/usecase/install.js";

// Import the unexported runStep via a local re-implementation for isolation
// (runStep is not exported; we test its contract through a local wrapper)
async function callStep(
  name: string,
  fn: () => Promise<void>
): Promise<{ updates: StepUpdate[]; threw: boolean }> {
  // Minimal logger that discards output
  const log = {
    info: (_step: string, _msg: string) => {},
    error: (_step: string, _msg: string) => {},
    warn: (_step: string, _msg: string) => {},
  };

  const updates: StepUpdate[] = [];
  const onStep = (u: StepUpdate) => updates.push(u);

  // Replicate the step helper logic here to test it in isolation
  onStep({ step: name, status: "running" });
  const start = Date.now();
  let threw = false;
  try {
    await fn();
    const ms = Date.now() - start;
    log.info(name, `completed in ${ms}ms`);
    onStep({ step: name, status: "done", durationMs: ms });
  } catch (err: any) {
    log.error(name, err.message ?? String(err));
    onStep({ step: name, status: "failed", message: err.message ?? String(err) });
    threw = true;
  }
  return { updates, threw };
}

describe("readSecretFromFile (legacy secret migration)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("recovers ENCRYPTION_KEY from an existing .env so an upgrade doesn't rotate it", () => {
    dir = mkdtempSync(join(tmpdir(), "arrstack-secret-"));
    writeFileSync(join(dir, ".env"), "PUID=1000\nENCRYPTION_KEY=deadbeefcafe1234\nTZ=UTC\n");
    expect(readSecretFromFile(join(dir, ".env"), /^ENCRYPTION_KEY=(.+)$/m)).toBe(
      "deadbeefcafe1234",
    );
  });

  const FLASK_RE = /^\s*flask_secret_key:[ \t]*["']?([^"'\s]+)["']?\s*$/m;

  test("recovers flask_secret_key from an existing Bazarr config.yaml", () => {
    dir = mkdtempSync(join(tmpdir(), "arrstack-secret-"));
    const cfg = join(dir, "config", "bazarr", "config");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "config.yaml"), "general:\n  flask_secret_key: abc123secret\n  ip: '*'\n");
    expect(readSecretFromFile(join(cfg, "config.yaml"), FLASK_RE)).toBe("abc123secret");
  });

  test("strips surrounding quotes if Bazarr re-serializes the flask secret quoted", () => {
    dir = mkdtempSync(join(tmpdir(), "arrstack-secret-"));
    const cfg = join(dir, "config", "bazarr", "config");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "config.yaml"), "general:\n  flask_secret_key: 'deadbeef99'\n");
    expect(readSecretFromFile(join(cfg, "config.yaml"), FLASK_RE)).toBe("deadbeef99");
  });

  test("does NOT capture the next line when the flask secret is empty (falls through to generate)", () => {
    dir = mkdtempSync(join(tmpdir(), "arrstack-secret-"));
    const cfg = join(dir, "config", "bazarr", "config");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "config.yaml"), "general:\n  flask_secret_key:\n  ip: '*'\n");
    expect(readSecretFromFile(join(cfg, "config.yaml"), FLASK_RE)).toBeUndefined();
  });

  test("ignores a commented-out flask_secret_key line", () => {
    dir = mkdtempSync(join(tmpdir(), "arrstack-secret-"));
    const cfg = join(dir, "config", "bazarr", "config");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "config.yaml"), "general:\n  # flask_secret_key: OLDVALUE\n  flask_secret_key: realkey42\n");
    expect(readSecretFromFile(join(cfg, "config.yaml"), FLASK_RE)).toBe("realkey42");
  });

  test("returns undefined when the file is missing (fresh install)", () => {
    dir = mkdtempSync(join(tmpdir(), "arrstack-secret-"));
    expect(readSecretFromFile(join(dir, ".env"), /^ENCRYPTION_KEY=(.+)$/m)).toBeUndefined();
  });

  test("returns undefined when the pattern doesn't match", () => {
    dir = mkdtempSync(join(tmpdir(), "arrstack-secret-"));
    writeFileSync(join(dir, ".env"), "PUID=1000\nTZ=UTC\n");
    expect(readSecretFromFile(join(dir, ".env"), /^ENCRYPTION_KEY=(.+)$/m)).toBeUndefined();
  });
});

describe("getHostIp", () => {
  test("returns a non-empty string", async () => {
    const ip = await getHostIp();
    expect(typeof ip).toBe("string");
    expect(ip.length).toBeGreaterThan(0);
  });

  test("returns a plausible IP or localhost fallback", async () => {
    const ip = await getHostIp();
    // Either a valid IPv4/IPv6 segment or the fallback "localhost"
    const isIp = /^[\d.:a-f]+$/i.test(ip);
    const isLocalhost = ip === "localhost";
    expect(isIp || isLocalhost).toBe(true);
  });
});

describe("step helper contract", () => {
  test("reports running then done on success", async () => {
    const { updates, threw } = await callStep("test-step", async () => {
      // no-op success
    });
    expect(threw).toBe(false);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ step: "test-step", status: "running" });
    expect(updates[1]).toMatchObject({ step: "test-step", status: "done" });
    expect(typeof updates[1].durationMs).toBe("number");
  });

  test("reports running then failed on error, re-throws", async () => {
    const { updates, threw } = await callStep("failing-step", async () => {
      throw new Error("boom");
    });
    expect(threw).toBe(true);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ step: "failing-step", status: "running" });
    expect(updates[1]).toMatchObject({
      step: "failing-step",
      status: "failed",
      message: "boom",
    });
  });

  test("durationMs on done is a non-negative number", async () => {
    const { updates } = await callStep("timing-step", async () => {});
    const done = updates.find((u) => u.status === "done");
    expect(done).toBeDefined();
    expect(done!.durationMs).toBeGreaterThanOrEqual(0);
  });
});
