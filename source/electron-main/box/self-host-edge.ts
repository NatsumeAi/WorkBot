import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  GATEWAY_EVENTS_PATH,
  GATEWAY_SSE_ACCEPT_HEADERS,
} from "../../shared/gateway-wire.js";
import {
  DOCKER_ENGINE_INSTALL_URL,
  SELF_HOST_DEFAULT_GATEWAY_PORT,
  SELF_HOST_DEFAULT_SSH_PORT,
  selfHostOneLiner,
} from "../../shared/self-host-box.js";
import {
  clearSelfHostGateway,
  newSelfHostToken,
  readSelfHostGateway,
  writeSelfHostGateway,
} from "./self-host-credentials.js";
import { installSelfHostBox, type SelfHostInstallRequest } from "./self-host-install.js";
import type { SelfHostSshTarget } from "./self-host-ssh.js";

export interface SelfHostEdgePorts {
  readonly settingsPath: string;
  readonly restartCoordinator: () => void;
  readonly openInSystemBrowser: (url: string) => Promise<unknown>;
  readonly resourcesPath: string;
  readonly showOpenDialog: (options: {
    readonly title: string;
    readonly properties: readonly ["openFile"];
  }) => Promise<{ canceled: boolean; filePaths: readonly string[] }>;
  readonly onProgress?: (line: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalPort(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (parsed > 0) return parsed;
  }
  return fallback;
}

function sshTarget(raw: Record<string, unknown>, fallbackPort: number): SelfHostSshTarget | undefined {
  const host = optionalString(raw.host);
  const username = optionalString(raw.username);
  if (host == null || username == null) return undefined;
  const password = optionalString(raw.password);
  const privateKeyPath = optionalString(raw.privateKeyPath);
  const passphrase = optionalString(raw.passphrase);
  return {
    host,
    port: optionalPort(raw.port, fallbackPort),
    username,
    ...(password == null ? {} : { password }),
    ...(privateKeyPath == null ? {} : { privateKeyPath }),
    ...(passphrase == null ? {} : { passphrase }),
  };
}

async function docsPath(resourcesPath: string): Promise<string> {
  const packaged = join(resourcesPath, "docs", "self-host.md");
  try {
    await access(packaged);
    return packaged;
  } catch { /* unpackaged source tree */ }
  return fileURLToPath(new URL("../../../docs/self-host.md", import.meta.url));
}

async function probeGateway(gatewayUrl: string, token: string): Promise<{ ok: boolean; message: string }> {
  if (gatewayUrl.length === 0) return { ok: false, message: "Not connected." };
  try {
    const response = await fetch(`${gatewayUrl}${GATEWAY_EVENTS_PATH}`, {
      headers: {
        ...GATEWAY_SSE_ACCEPT_HEADERS,
        ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(3_000),
    });
    void response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: token.length > 0 ? "Wrong token." : "Enter a token." };
    }
    return response.ok ? { ok: true, message: "Connected." } : { ok: false, message: "Can't reach that URL." };
  } catch {
    return { ok: false, message: "Can't reach that URL." };
  }
}

export function createSelfHostEdgePort(ports: SelfHostEdgePorts) {
  return {
    async getConnection() {
      const envUrl = process.env.SAND_HOST_GATEWAY_URL?.trim() ?? "";
      const stored = await readSelfHostGateway(ports.settingsPath);
      const gatewayUrl = (envUrl.length > 0 ? envUrl : stored?.gatewayUrl ?? "").replace(/\/$/, "");
      const token = envUrl.length > 0 ? (process.env.SAND_HOST_GATEWAY_TOKEN?.trim() ?? "") : stored?.token ?? "";
      const hasToken = token.length > 0;
      const probed = gatewayUrl.length > 0 ? await probeGateway(gatewayUrl, token) : { ok: false, message: "Not connected." };
      return {
        envOverrides: envUrl.length > 0,
        gatewayUrl,
        hasToken,
        host: stored?.host ?? "",
        username: stored?.username ?? "",
        sshPort: stored?.sshPort ?? SELF_HOST_DEFAULT_SSH_PORT,
        gatewayPort: stored?.gatewayPort ?? SELF_HOST_DEFAULT_GATEWAY_PORT,
        status: gatewayUrl.length === 0 ? "missing" : probed.ok ? "connected" : "saved",
        statusMessage: probed.message,
        dockerInstallUrl: DOCKER_ENGINE_INSTALL_URL,
        defaultGatewayPort: SELF_HOST_DEFAULT_GATEWAY_PORT,
        defaultSshPort: SELF_HOST_DEFAULT_SSH_PORT,
      };
    },
    async setConnection(raw: unknown) {
      const request = asRecord(raw);
      const gatewayUrl = optionalString(request.gatewayUrl);
      const token = optionalString(request.token);
      if (request.clear === true || (gatewayUrl == null && token == null && request.gatewayUrl === "")) {
        await clearSelfHostGateway(ports.settingsPath);
        ports.restartCoordinator();
        return { gatewayUrl: "", hasToken: false, status: "missing", statusMessage: "Not connected." };
      }
      const stored = await readSelfHostGateway(ports.settingsPath);
      const nextUrl = gatewayUrl ?? stored?.gatewayUrl;
      const nextToken = token ?? stored?.token;
      if (nextUrl == null || nextToken == null) {
        return { gatewayUrl: stored?.gatewayUrl ?? "", hasToken: stored != null, status: stored == null ? "missing" : "saved", statusMessage: "Enter an access URL and token.", message: "Enter an access URL and token." };
      }
      const saved = await writeSelfHostGateway(ports.settingsPath, {
        gatewayUrl: nextUrl,
        token: nextToken,
        host: optionalString(request.host) ?? stored?.host,
        username: optionalString(request.username) ?? stored?.username,
        sshPort: optionalPort(request.port ?? request.sshPort, stored?.sshPort ?? SELF_HOST_DEFAULT_SSH_PORT),
        gatewayPort: optionalPort(request.gatewayPort, stored?.gatewayPort ?? SELF_HOST_DEFAULT_GATEWAY_PORT),
      });
      ports.restartCoordinator();
      const probed = await probeGateway(saved.gatewayUrl, saved.token);
      return { gatewayUrl: saved.gatewayUrl, hasToken: true, status: probed.ok ? "connected" : "saved", statusMessage: probed.message };
    },
    getInstallCommand(raw: unknown) {
      const request = asRecord(raw);
      const token = optionalString(request.token) ?? newSelfHostToken();
      const gatewayPort = optionalPort(request.gatewayPort, SELF_HOST_DEFAULT_GATEWAY_PORT);
      const tlsCertPath = optionalString(request.tlsCertPath);
      const tlsKeyPath = optionalString(request.tlsKeyPath);
      return {
        command: selfHostOneLiner({
          token,
          gatewayPort,
          ...(tlsCertPath != null && tlsKeyPath != null ? { tlsCertPath, tlsKeyPath } : {}),
        }),
        token,
      };
    },
    async install(raw: unknown) {
      const request = asRecord(raw);
      const target = sshTarget(request, SELF_HOST_DEFAULT_SSH_PORT);
      if (target == null) return { status: "error", message: "Enter the server, SSH port, and username." };
      const jumpRaw = asRecord(request.jump);
      const jump = sshTarget(jumpRaw, SELF_HOST_DEFAULT_SSH_PORT);
      const accessUrl = optionalString(request.accessUrl);
      const tlsCertPath = optionalString(request.tlsCertPath);
      const tlsKeyPath = optionalString(request.tlsKeyPath);
      const payload: SelfHostInstallRequest = {
        ...target,
        acceptHostKey: request.acceptHostKey === true,
        gatewayPort: optionalPort(request.gatewayPort, SELF_HOST_DEFAULT_GATEWAY_PORT),
        ...(accessUrl == null ? {} : { accessUrl }),
        ...(tlsCertPath == null ? {} : { tlsCertPath }),
        ...(tlsKeyPath == null ? {} : { tlsKeyPath }),
        ...(jump == null ? {} : { jump }),
      };
      const result = await installSelfHostBox({
        settingsPath: ports.settingsPath,
        request: payload,
        ...(ports.onProgress == null ? {} : { onProgress: ports.onProgress }),
      });
      if (result.status === "ok") ports.restartCoordinator();
      return result;
    },
    async testGateway(raw: unknown) {
      const request = asRecord(raw);
      const stored = await readSelfHostGateway(ports.settingsPath);
      const gatewayUrl = (optionalString(request.gatewayUrl) ?? stored?.gatewayUrl ?? "").replace(/\/$/, "");
      const token = optionalString(request.token) ?? stored?.token ?? "";
      if (gatewayUrl.length === 0) return { ok: false, message: "Enter an access URL." };
      return probeGateway(gatewayUrl, token);
    },
    async pickKeyFile() {
      const result = await ports.showOpenDialog({ title: "Choose an SSH key", properties: ["openFile"] });
      if (result.canceled || result.filePaths[0] == null) return null;
      return result.filePaths[0];
    },
    async openDocs() {
      const target = await docsPath(ports.resourcesPath);
      await ports.openInSystemBrowser(pathToFileURL(target).href);
    },
  };
}
