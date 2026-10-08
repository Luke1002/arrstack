import { describe, expect, test, afterEach } from "bun:test";
import {
  configureBazarrProviderHub,
  providerHubTargets,
} from "../../src/wiring/bazarr-providerhub";

const FLARE = "http://flaresolverr:8191/v1";
const IDS = ["opensubtitles", "embeddedsubtitles", "yifysubtitles", "opensubtitlescom", "addic7ed"];

function fakeCatalog() {
  return {
    sources: {},
    entries: IDS.map((id) => ({ provider_id: id, version: "1.0.0", manifest: { provider_id: id } })),
  };
}

// A stateful fake of the Bazarr+ Provider Hub API: POST /installations adds the
// provider to the installed set, so the subsequent GET /providers (which
// waitForInstalled polls) sees it. Without this the install would "never finish"
// and every provider would time out.
function makeStatefulFetch(
  opts: { preinstalled?: string[]; installThrows?: boolean; statusFailsTimes?: number } = {},
) {
  const installed = new Set<string>(opts.preinstalled ?? []);
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  let statusCalls = 0;
  const fetchFn = async (url: any, init: any = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: u, body });
    if (u.endsWith("/api/system/status")) {
      // Simulate Bazarr+'s DB-migration window: 500 a few times, then live.
      statusCalls += 1;
      const ready = statusCalls > (opts.statusFailsTimes ?? 0);
      return new Response(ready ? "{}" : "migrating", { status: ready ? 200 : 500 });
    }
    if (u.endsWith("/provider-hub/catalog")) {
      return new Response(JSON.stringify(fakeCatalog()), { status: 200 });
    }
    if (u.endsWith("/provider-hub/providers")) {
      return new Response(
        JSON.stringify({ data: [...installed].map((id) => ({ provider_id: id })) }),
        { status: 200 },
      );
    }
    if (u.endsWith("/provider-hub/installations")) {
      if (opts.installThrows) throw new Error("network boom");
      installed.add(body.manifest.provider_id);
      return new Response("{}", { status: 200 });
    }
    // PATCH /provider-hub/providers/<id>
    return new Response("{}", { status: 200 });
  };
  return { fetchFn, calls };
}

describe("providerHubTargets", () => {
  test("is the migrated set; podnapisi absent; opensubtitles carries flaresolverr_url", () => {
    const t = providerHubTargets(FLARE);
    expect(t.map((x) => x.id)).toEqual(IDS);
    expect(t.map((x) => x.id)).not.toContain("podnapisi");
    expect(t.find((x) => x.id === "opensubtitles")!.config).toEqual({ flaresolverr_url: FLARE });
  });
});

describe("configureBazarrProviderHub", () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
  });

  test("installs each not-yet-installed provider then enables it", async () => {
    const { fetchFn, calls } = makeStatefulFetch();
    globalThis.fetch = fetchFn as any;

    await configureBazarrProviderHub({
      apiKey: "K",
      flaresolverrUrl: FLARE,
      base: "http://bz.test",
      pollTimeoutMs: 500,
      pollIntervalMs: 5,
    });

    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/installations"))).toHaveLength(5);
    const osPatch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/providers/opensubtitles"));
    expect(osPatch?.body).toEqual({ enabled: true, config: { flaresolverr_url: FLARE } });
    const emb = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/providers/embeddedsubtitles"));
    expect(emb?.body).toEqual({ enabled: true });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(5);
  });

  test("skips install for an already-installed provider (idempotent), still enables it", async () => {
    const { fetchFn, calls } = makeStatefulFetch({ preinstalled: ["opensubtitles"] });
    globalThis.fetch = fetchFn as any;

    await configureBazarrProviderHub({
      apiKey: "K",
      flaresolverrUrl: FLARE,
      base: "http://bz.test",
      pollTimeoutMs: 500,
      pollIntervalMs: 5,
    });

    // Only the other 4 get an install POST.
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/installations"))).toHaveLength(4);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/providers/opensubtitles"))).toBe(true);
  });

  test("a per-provider failure warns and does not throw", async () => {
    const warnings: string[] = [];
    const { fetchFn } = makeStatefulFetch({ installThrows: true });
    globalThis.fetch = fetchFn as any;

    await expect(
      configureBazarrProviderHub({
        apiKey: "K",
        flaresolverrUrl: FLARE,
        base: "http://bz.test",
        pollTimeoutMs: 30,
        pollIntervalMs: 5,
        log: (m) => warnings.push(m),
      }),
    ).resolves.toBeUndefined();
    expect(warnings.some((w) => w.toLowerCase().includes("opensubtitles"))).toBe(true);
    expect(warnings.length).toBeGreaterThanOrEqual(5); // one warning per provider
  });

  test("waits out Bazarr's post-restart HTTP 500 window instead of silently no-opping", async () => {
    // The update path only gates on /api/system/ping (200 early), so the API can
    // still 500 for 30-60s during DB migrations. /api/system/status 500s twice
    // then goes live; the readiness gate must wait, then install all providers,
    // NOT skip them as 'not in the catalog'.
    const warnings: string[] = [];
    const { fetchFn, calls } = makeStatefulFetch({ statusFailsTimes: 2 });
    globalThis.fetch = fetchFn as any;

    await configureBazarrProviderHub({
      apiKey: "K",
      flaresolverrUrl: FLARE,
      base: "http://bz.test",
      pollTimeoutMs: 500,
      pollIntervalMs: 5,
      readyIntervalMs: 5, // don't wait the real 2s between readiness polls
      log: (m) => warnings.push(m),
    });

    // Readiness gate polled status 3 times (500, 500, 200) before proceeding.
    expect(calls.filter((c) => c.url.endsWith("/api/system/status"))).toHaveLength(3);
    // All 5 providers installed (the feature did NOT no-op).
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/installations"))).toHaveLength(5);
    expect(warnings.some((w) => w.includes("not in the catalog"))).toBe(false);
  });
});
