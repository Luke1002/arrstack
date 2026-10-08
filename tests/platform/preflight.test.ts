import { test, expect, describe, afterEach } from "bun:test";
import { checkPortFree } from "../../src/platform/ports.js";
import { checkNotRoot } from "../../src/platform/preflight.js";

describe("checkNotRoot", () => {
  const origGetuid = process.getuid;
  afterEach(() => {
    // @ts-expect-error restore original (may be undefined on some platforms)
    process.getuid = origGetuid;
  });

  test("passes as a normal user (non-zero uid)", () => {
    // @ts-expect-error stub
    process.getuid = () => 1000;
    const r = checkNotRoot();
    expect(r.ok).toBe(true);
    expect(r.blocking).toBe(false);
    expect(r.name).toBe("Not running as root");
  });

  test("fails (warning) when uid is 0, and never blocks", () => {
    // @ts-expect-error stub
    process.getuid = () => 0;
    const r = checkNotRoot();
    expect(r.ok).toBe(false);
    // A root warning must never hard-block the install.
    expect(r.blocking).toBe(false);
    expect(r.message.toLowerCase()).toContain("root");
  });
});

describe("checkPortFree", () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];

  afterEach(() => {
    for (const server of servers) {
      server.stop(true);
    }
    servers.length = 0;
  });

  test("reports a bound port as in-use", async () => {
    // Bind on port 0 to get a random free port assigned by the OS
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("ok");
      },
    });
    servers.push(server);

    const boundPort = server.port;
    expect(boundPort).toBeGreaterThan(0);

    const free = await checkPortFree(boundPort);
    expect(free).toBe(false);
  });

  test("reports a high unused port as free", async () => {
    // Port 59999 is very unlikely to be in use in a CI environment
    const free = await checkPortFree(59999);
    expect(free).toBe(true);
  });
});
