import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  DOCKER_ENGINE_INSTALL_URL,
  SELF_HOST_DEFAULT_GATEWAY_PORT,
  selfHostInstallScript,
  selfHostRemoteBoxExecDir,
  selfHostRemoteHostMainPath,
  selfHostRemoteRoot,
  selfHostVisibleProgressLine,
} from "../../shared/self-host-box.js";
import { newSelfHostToken, writeSelfHostGateway } from "./self-host-credentials.js";
import {
  classifySelfHostSshError,
  openSelfHostSshSession,
  SelfHostNeedHostConfirmError,
  type SelfHostSshTarget,
} from "./self-host-ssh.js";

function throttleProgress(emit: (line: string) => void, minIntervalMs = 250): { push(line: string): void; flush(): void } {
  let lastEmittedAt = 0;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = (line: string): void => {
    pending = null;
    lastEmittedAt = Date.now();
    emit(line);
  };
  return {
    push(line: string): void {
      const wait = minIntervalMs - (Date.now() - lastEmittedAt);
      if (wait <= 0) {
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
        send(line);
        return;
      }
      pending = line;
      if (timer == null) {
        timer = setTimeout(() => {
          timer = null;
          if (pending != null) send(pending);
        }, wait);
      }
    },
    flush(): void {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending != null) send(pending);
    },
  };
}

export interface SelfHostInstallRequest {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password?: string;
  readonly privateKeyPath?: string;
  readonly passphrase?: string;
  readonly jump?: SelfHostSshTarget;
  readonly acceptHostKey: boolean;
  readonly gatewayPort: number;
  readonly accessUrl?: string;
  readonly tlsCertPath?: string;
  readonly tlsKeyPath?: string;
}

export type SelfHostInstallResult =
  | { readonly status: "confirm-host"; readonly host: string; readonly port: number; readonly fingerprintSha256: string }
  | { readonly status: "ok"; readonly gatewayUrl: string; readonly token: string; readonly lines: readonly string[] }
  | { readonly status: "error"; readonly message: string; readonly dockerInstallUrl?: string };

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readRuntimeFile(relative: string): Promise<Buffer> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(moduleDirectory, `../${relative}`), resolve(moduleDirectory, `../../${relative}`)];
  for (const candidate of candidates) {
    try { return await readFile(candidate); } catch { /* next */ }
  }
  throw new Error(`The reconstructed runtime is unavailable at ${candidates.join(" or ")}.`);
}

async function writeTempRuntime(name: string, bytes: Buffer): Promise<string> {
  const directory = join(tmpdir(), `openbot-self-host-${process.pid}-${randomBytes(8).toString("hex")}`);
  await mkdir(directory, { recursive: true });
  const target = join(directory, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o600 });
  return target;
}

function defaultAccessUrl(host: string, port: number, tls: boolean): string {
  return `${tls ? "https" : "http"}://${host}:${port}`;
}

export async function installSelfHostBox(args: {
  readonly settingsPath: string;
  readonly request: SelfHostInstallRequest;
  readonly onProgress?: (line: string) => void;
}): Promise<SelfHostInstallResult> {
  const request = args.request;
  const progress = (line: string): void => { args.onProgress?.(line); };
  const token = newSelfHostToken();
  const tlsLocal = request.tlsCertPath != null && request.tlsKeyPath != null
    && await fileExists(request.tlsCertPath) && await fileExists(request.tlsKeyPath);

  let session;
  try {
    progress("Connecting…");
    session = await openSelfHostSshSession({
      settingsPath: args.settingsPath,
      target: {
        host: request.host,
        port: request.port,
        username: request.username,
        ...(request.password != null ? { password: request.password } : {}),
        ...(request.privateKeyPath != null ? { privateKeyPath: request.privateKeyPath } : {}),
        ...(request.passphrase != null ? { passphrase: request.passphrase } : {}),
      },
      ...(request.jump != null ? { jump: request.jump } : {}),
      acceptHostKey: request.acceptHostKey,
    });
  } catch (error) {
    if (error instanceof SelfHostNeedHostConfirmError) {
      return { status: "confirm-host", host: error.host, port: error.port, fingerprintSha256: error.fingerprintSha256 };
    }
    return { status: "error", message: classifySelfHostSshError(error) };
  }

  try {
    progress("Uploading…");
    const home = await session.exec('printf %s "${HOME}"');
    const homeDir = home.stdout.trim();
    if (home.code !== 0 || homeDir.length === 0 || !homeDir.startsWith("/")) {
      return { status: "error", message: "Could not read the home directory on that server." };
    }
    const remoteRoot = selfHostRemoteRoot(homeDir);
    const remoteCert = tlsLocal ? `${remoteRoot}/tls/cert` : request.tlsCertPath;
    const remoteKey = tlsLocal ? `${remoteRoot}/tls/key` : request.tlsKeyPath;
    const script = selfHostInstallScript({
      token,
      gatewayPort: request.gatewayPort > 0 ? request.gatewayPort : SELF_HOST_DEFAULT_GATEWAY_PORT,
      remoteRoot,
      ...(typeof remoteCert === "string" && typeof remoteKey === "string" ? { tlsCertPath: remoteCert, tlsKeyPath: remoteKey } : {}),
    });
    const hostBytes = await readRuntimeFile("host/host-main.cjs");
    const daemonBytes = await readRuntimeFile("box-exec-daemon/main.cjs");
    const hostLocal = await writeTempRuntime("host-main.cjs", hostBytes);
    const daemonLocal = await writeTempRuntime("box-exec-daemon/main.cjs", daemonBytes);
    await session.mkdirp(selfHostRemoteBoxExecDir(remoteRoot));
    await session.putFile(hostLocal, selfHostRemoteHostMainPath(remoteRoot));
    await session.putFile(daemonLocal, `${selfHostRemoteBoxExecDir(remoteRoot)}/main.cjs`);
    if (tlsLocal && request.tlsCertPath != null && request.tlsKeyPath != null && remoteCert != null && remoteKey != null) {
      await session.mkdirp(`${remoteRoot}/tls`);
      await session.putFile(request.tlsCertPath, remoteCert);
      await session.putFile(request.tlsKeyPath, remoteKey);
    }
    progress("Starting Docker…");
    const scriptLocal = await writeTempRuntime("install.sh", Buffer.from(`${script}\n`, "utf8"));
    const remoteScript = `${remoteRoot}/install.sh`;
    await session.putFile(scriptLocal, remoteScript);
    const live = throttleProgress(progress);
    let lastBeat = Date.now();
    const beat = setInterval(() => {
      if (Date.now() - lastBeat < 8_000) return;
      live.push("Still working… Docker pull can take several minutes.");
    }, 8_000);
    let ran;
    try {
      ran = await session.exec(`sh ${remoteScript}`, {
        timeoutMs: 12 * 60_000,
        onOutput: (chunk) => {
          const line = selfHostVisibleProgressLine(chunk);
          if (line != null) {
            lastBeat = Date.now();
            live.push(line);
          }
        },
      });
    } finally {
      clearInterval(beat);
    }
    live.flush();
    const output = `${ran.stdout}\n${ran.stderr}`;
    if (output.includes("docker is not installed") || /command not found.*docker|docker: not found/i.test(output)) {
      return { status: "error", message: "This machine doesn't have Docker yet.", dockerInstallUrl: DOCKER_ENGINE_INSTALL_URL };
    }
    if (output.includes("cannot run Docker")) {
      return { status: "error", message: "This user cannot run Docker. Add them to the docker group, then log in again." };
    }
    if (ran.code !== 0) {
      const tail = output.trim().slice(-400);
      return { status: "error", message: tail.length > 0 ? tail : "Install failed." };
    }
    const gatewayPort = request.gatewayPort > 0 ? request.gatewayPort : SELF_HOST_DEFAULT_GATEWAY_PORT;
    const gatewayUrl = (request.accessUrl?.trim() || defaultAccessUrl(request.host, gatewayPort, remoteCert != null && remoteKey != null)).replace(/\/$/, "");
    await writeSelfHostGateway(args.settingsPath, {
      gatewayUrl,
      token,
      host: request.host,
      username: request.username,
      sshPort: request.port,
      gatewayPort,
    });
    progress("Saved.");
    return { status: "ok", gatewayUrl, token, lines: ["Installed.", `Saved ${gatewayUrl}`] };
  } catch (error) {
    return { status: "error", message: classifySelfHostSshError(error) };
  } finally {
    session.end();
  }
}
