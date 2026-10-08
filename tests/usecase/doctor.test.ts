import { describe, test, expect } from "bun:test";
import { classifyCheck } from "../../src/usecase/doctor.js";
import type { CheckResult } from "../../src/platform/preflight.js";

function check(over: Partial<CheckResult>): CheckResult {
  return { name: "c", ok: true, message: "", blocking: true, ...over };
}

describe("classifyCheck", () => {
  test("a passing check passes", () => {
    expect(classifyCheck(check({ ok: true }))).toBe("pass");
  });

  test("a failing NON-blocking check is a warning, not a failure (root advisory)", () => {
    // This is the regression the review flagged: doctor must not exit non-zero
    // just because the box is running as root.
    expect(classifyCheck(check({ ok: false, blocking: false }))).toBe("warn");
  });

  test("a failing blocking check is a hard failure", () => {
    expect(classifyCheck(check({ ok: false, blocking: true }))).toBe("fail");
  });
});
