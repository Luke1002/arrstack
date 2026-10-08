import { fetchWithRetry } from "../lib/retry.js";
import { waitForBazarrApiReady } from "./bazarr.js";

// Bazarr+ 2.4.0 loads subtitle providers from the Provider Hub (the built-in
// providers are being retired). This wires the installer's default set via the
// Hub REST API: GET /catalog for each provider's manifest, POST /installations
// to stage the install (async: downloads a bundle + builds an isolated venv),
// poll until it appears, then PATCH /providers/<id> to enable + configure it.
// Idempotent (skips already-installed) and best-effort (a provider that fails
// warns and never aborts the install/update).

export interface ProviderHubTarget {
  id: string;
  config?: Record<string, unknown>;
}

// The migrated default set. podnapisi is intentionally absent (dead, not in the
// catalog). opensubtitles carries the FlareSolverr fallback endpoint; the two
// credential providers (opensubtitlescom, addic7ed) are enabled but left
// unconfigured for the user to fill in via Settings -> Provider Hub.
export function providerHubTargets(flaresolverrUrl: string): ProviderHubTarget[] {
  return [
    { id: "opensubtitles", config: { flaresolverr_url: flaresolverrUrl } },
    { id: "embeddedsubtitles" },
    { id: "yifysubtitles" },
    { id: "opensubtitlescom" },
    { id: "addic7ed" },
  ];
}

export interface ProviderHubOptions {
  apiKey: string;
  flaresolverrUrl: string;
  base?: string;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  log?: (msg: string) => void;
}

interface CatalogEntry {
  provider_id?: string;
  manifest?: unknown;
}

// Per-request timeout so a wedged Bazarr+ (accepts the socket but never answers)
// cannot hang an unattended install/update. Bun's fetch has no default timeout.
const REQ_TIMEOUT_MS = 15_000;
// POST /installations blocks while the Hub downloads the provider bundle and
// builds its isolated venv, which for heavy providers (e.g. opensubtitles pulls
// ai-cloudscraper) takes well over REQ_TIMEOUT_MS. Give it a generous cap so it
// isn't falsely reported as failed (which would also skip its enable+config).
const INSTALL_TIMEOUT_MS = 180_000;

export async function configureBazarrProviderHub(opts: ProviderHubOptions): Promise<void> {
  const base = opts.base ?? "http://localhost:6767";
  const log = opts.log ?? (() => {});
  const headers = { "X-API-KEY": opts.apiKey, "Content-Type": "application/json" };
  const timeoutMs = opts.pollTimeoutMs ?? 120_000;
  const intervalMs = opts.pollIntervalMs ?? 3000;
  const targets = providerHubTargets(opts.flaresolverrUrl);

  // Readiness gate: after `up` (especially on update) Bazarr+ answers /ping and
  // /health with 200 while its DB migrations still 500 the real API for 30-60s.
  // Poll the authenticated /api/system/status until it is truly live before
  // touching the Provider Hub, otherwise every install below silently no-ops.
  await waitForBazarrApiReady(base, opts.apiKey, opts.readyTimeoutMs, opts.readyIntervalMs);

  // fetchWithRetry forgives a transient 500/401 (plain fetch resolves on 500 and
  // would not be retried); still check .ok before parsing the body.
  const catRes = await fetchWithRetry(`${base}/api/provider-hub/catalog`, {
    headers,
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });
  if (!catRes.ok) throw new Error(`catalog returned ${catRes.status}`);
  const catalog = (await catRes.json()) as { entries?: CatalogEntry[] };
  const manifestById = new Map<string, unknown>();
  for (const e of catalog.entries ?? []) {
    if (e.provider_id) manifestById.set(e.provider_id, e.manifest);
  }

  for (const target of targets) {
    try {
      if (!(await installedIds(base, headers)).has(target.id)) {
        const manifest = manifestById.get(target.id);
        if (!manifest) {
          log(`Provider Hub: ${target.id} is not in the catalog; skipping`);
          continue;
        }
        const res = await fetch(`${base}/api/provider-hub/installations`, {
          method: "POST",
          headers,
          body: JSON.stringify({ manifest }),
          signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`install returned ${res.status}`);
        await waitForInstalled(base, headers, target.id, timeoutMs, intervalMs);
      }
      const patch = await fetch(`${base}/api/provider-hub/providers/${target.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabled: true, ...(target.config ? { config: target.config } : {}) }),
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      if (!patch.ok) throw new Error(`enable returned ${patch.status}`);
      log(`Provider Hub: ${target.id} installed + enabled`);
    } catch (err) {
      log(
        `Provider Hub: could not set up ${target.id} (${(err as Error).message}); ` +
          `install it later from Bazarr+ Settings, Provider Hub`,
      );
    }
  }
}

async function installedIds(
  base: string,
  headers: Record<string, string>,
): Promise<Set<string>> {
  const r = await fetch(`${base}/api/provider-hub/providers`, {
    headers,
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`list providers returned ${r.status}`);
  const j = (await r.json()) as { data?: Array<{ provider_id?: string; id?: string }> };
  return new Set(
    (j.data ?? []).map((p) => p.provider_id ?? p.id).filter((x): x is string => !!x),
  );
}

async function waitForInstalled(
  base: string,
  headers: Record<string, string>,
  id: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await installedIds(base, headers)).has(id)) return;
    } catch {
      // Transient error while the hub downloads the bundle / builds the venv
      // (it can 5xx mid-build). Keep polling rather than dropping this provider
      // on a single blip; the outer timeout still bounds the wait.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`install did not finish within ${Math.round(timeoutMs / 1000)}s`);
}
