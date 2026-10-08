import { exec } from "../lib/exec.js";
import { isDockerInstalled, isDockerRunning, isComposeV2 } from "./docker.js";
import { checkPortFree } from "./ports.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
  blocking: boolean;
}

// Running the installer as root makes every LinuxServer.io container run as
// root (PUID/PGID 0), which breaks them ("usermod: user abc is currently used
// by process 1") and litters root-owned files. Non-blocking: some users only
// have root, and the wizard now clamps PUID/PGID away from 0 regardless, so
// this is a warning rather than a hard stop.
export function checkNotRoot(): CheckResult {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const isRoot = uid === 0;
  return {
    name: "Not running as root",
    ok: !isRoot,
    message: isRoot
      ? "Running as root. LinuxServer.io containers misbehave as root; re-run as a normal user in the 'docker' group (PUID/PGID default to 1000)."
      : "Running as a normal user",
    blocking: false,
  };
}

async function checkDiskSpace(path: string, minGb: number): Promise<CheckResult> {
  const result = await exec(["df", "-Pk", path], { timeoutMs: 5000 });
  const name = `Disk space on ${path}`;

  if (!result.ok) {
    return { name, ok: false, message: `Could not check disk space on ${path}`, blocking: true };
  }

  // POSIX df output: last line, 4th column is available 1K-blocks.
  const lines = result.stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1];
  const cols = lastLine.split(/\s+/);
  const availKb = parseInt(cols[3], 10);
  if (isNaN(availKb)) {
    return { name, ok: false, message: `Could not parse disk space output`, blocking: true };
  }

  const availGb = Math.floor(availKb / (1024 * 1024));
  const ok = availGb >= minGb;
  return {
    name,
    ok,
    message: ok
      ? `${availGb}GB available (need ${minGb}GB)`
      : `Only ${availGb}GB available, need at least ${minGb}GB`,
    blocking: true,
  };
}

export interface PreflightOptions {
  // Skip the 80/443-free check. Set by `doctor` on an already-installed box
  // where OUR Caddy is expected to be holding those ports — otherwise doctor
  // always reports a spurious failure post-install.
  skipPortChecks?: boolean;
}

export async function runPreflight(
  storageRoot: string,
  opts: PreflightOptions = {}
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 0. Not running as root (warning only, non-blocking)
  results.push(checkNotRoot());

  // 1. Docker installed
  const dockerInstalled = await isDockerInstalled();
  results.push({
    name: "Docker installed",
    ok: dockerInstalled,
    message: dockerInstalled ? "Docker is installed" : "Docker is not installed",
    blocking: true,
  });

  // 2. Docker running
  const dockerRunning = await isDockerRunning();
  results.push({
    name: "Docker running",
    ok: dockerRunning,
    message: dockerRunning ? "Docker daemon is running" : "Docker daemon is not running",
    blocking: true,
  });

  // 3. Compose v2
  const composeV2 = await isComposeV2();
  results.push({
    name: "Docker Compose v2",
    ok: composeV2,
    message: composeV2 ? "Docker Compose v2 is available" : "Docker Compose v2 is not available",
    blocking: true,
  });

  // 4. Disk space on / and storage root
  results.push(await checkDiskSpace("/", 10));

  if (storageRoot !== "/") {
    results.push(await checkDiskSpace(storageRoot, 10));
  }

  // 5. Ports 80 and 443 free (skipped post-install; our own Caddy holds them
  // then, and flagging that as a failure just confuses users running `doctor`).
  if (!opts.skipPortChecks) {
    for (const port of [80, 443]) {
      const free = await checkPortFree(port);
      results.push({
        name: `Port ${port} free`,
        ok: free,
        message: free ? `Port ${port} is available` : `Port ${port} is already in use`,
        blocking: true,
      });
    }
  }

  return results;
}
