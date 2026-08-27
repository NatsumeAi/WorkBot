import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { SELF_HOST_CREDENTIAL_FILENAME, SELF_HOST_KNOWN_HOSTS_FILENAME } from "../../shared/self-host-box.js";

export interface SelfHostGatewayRecord {
  readonly schemaVersion: 1;
  readonly gatewayUrl: string;
  readonly token: string;
  readonly networkToken?: string;
}

export interface SelfHostKnownHostRecord {
  readonly fingerprintSha256: string;
}

interface KnownHostsFile {
  readonly schemaVersion: 1;
  readonly hosts: Record<string, SelfHostKnownHostRecord>;
}

export function selfHostCredentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), SELF_HOST_CREDENTIAL_FILENAME);
}

export function selfHostKnownHostsPath(settingsPath: string): string {
  return join(dirname(settingsPath), SELF_HOST_KNOWN_HOSTS_FILENAME);
}

export function knownHostId(host: string, port: number): string {
  return `${host}:${port}`;
}

export function fingerprintSha256(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex");
}

export function newSelfHostToken(): string {
  return randomBytes(32).toString("hex");
}

async function writeSecretJson(target: string, value: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function readSelfHostGateway(settingsPath: string): Promise<SelfHostGatewayRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(selfHostCredentialPath(settingsPath), "utf8")) as {
      schemaVersion?: unknown;
      gatewayUrl?: unknown;
      token?: unknown;
      networkToken?: unknown;
    };
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.gatewayUrl !== "string" || parsed.gatewayUrl.trim().length === 0) return null;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    return {
      schemaVersion: 1,
      gatewayUrl: parsed.gatewayUrl.trim(),
      token: parsed.token,
      ...(typeof parsed.networkToken === "string" && parsed.networkToken.length > 0 ? { networkToken: parsed.networkToken } : {}),
    };
  } catch {
    return null;
  }
}

export async function writeSelfHostGateway(settingsPath: string, record: Omit<SelfHostGatewayRecord, "schemaVersion">): Promise<SelfHostGatewayRecord> {
  const stored: SelfHostGatewayRecord = {
    schemaVersion: 1,
    gatewayUrl: record.gatewayUrl.trim(),
    token: record.token,
    ...(record.networkToken != null && record.networkToken.length > 0 ? { networkToken: record.networkToken } : {}),
  };
  await writeSecretJson(selfHostCredentialPath(settingsPath), stored);
  return stored;
}

export async function clearSelfHostGateway(settingsPath: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(selfHostCredentialPath(settingsPath));
  } catch {
  }
}

async function readKnownHostsFile(settingsPath: string): Promise<KnownHostsFile> {
  try {
    const parsed = JSON.parse(await readFile(selfHostKnownHostsPath(settingsPath), "utf8")) as {
      schemaVersion?: unknown;
      hosts?: unknown;
    };
    if (parsed.schemaVersion !== 1 || typeof parsed.hosts !== "object" || parsed.hosts == null || Array.isArray(parsed.hosts)) {
      return { schemaVersion: 1, hosts: {} };
    }
    const hosts: Record<string, SelfHostKnownHostRecord> = {};
    for (const [id, value] of Object.entries(parsed.hosts as Record<string, unknown>)) {
      if (typeof value !== "object" || value == null || Array.isArray(value)) continue;
      const fingerprintSha256Value = (value as { fingerprintSha256?: unknown }).fingerprintSha256;
      if (typeof fingerprintSha256Value === "string" && fingerprintSha256Value.length > 0) {
        hosts[id] = { fingerprintSha256: fingerprintSha256Value };
      }
    }
    return { schemaVersion: 1, hosts };
  } catch {
    return { schemaVersion: 1, hosts: {} };
  }
}

export async function readKnownHost(settingsPath: string, host: string, port: number): Promise<SelfHostKnownHostRecord | null> {
  const file = await readKnownHostsFile(settingsPath);
  return file.hosts[knownHostId(host, port)] ?? null;
}

export async function writeKnownHost(settingsPath: string, host: string, port: number, fingerprint: string): Promise<void> {
  const file = await readKnownHostsFile(settingsPath);
  await writeSecretJson(selfHostKnownHostsPath(settingsPath), {
    schemaVersion: 1,
    hosts: { ...file.hosts, [knownHostId(host, port)]: { fingerprintSha256: fingerprint } },
  });
}
