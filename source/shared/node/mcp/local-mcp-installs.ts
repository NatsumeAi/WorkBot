import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AccountDisplayConfig, DisplayServer, McpServerConfig } from "./mcp-display-runtime.js";
import type { SandMarketplacePlugin } from "./mcp-marketplace.js";
import { SandMcpConfigError } from "./mcp-config-error.js";

export const LOCAL_MCP_INSTALLS_FILENAME = "mcp-local-installs.json";
export const LOCAL_MCP_CACHE_SCOPE = "local";
const LOCAL_ID_START = 9_000_000_001;

export interface LocalMcpInstallServer {
  readonly id: string;
  readonly name: string;
  readonly serverIdentifier: string;
  readonly config: McpServerConfig;
}

export interface LocalMcpInstall {
  readonly pluginId: string;
  readonly displayName: string;
  readonly servers: readonly LocalMcpInstallServer[];
}

export function localMcpInstallsPath(settingsPath: string): string {
  return join(dirname(settingsPath), LOCAL_MCP_INSTALLS_FILENAME);
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.command === "string" && item.command.length > 0) return true;
  return typeof item.url === "string" && item.url.length > 0;
}

function parseServer(value: unknown): LocalMcpInstallServer | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !/^[1-9]\d*$/.test(item.id)) return null;
  if (typeof item.name !== "string" || item.name.length === 0) return null;
  if (typeof item.serverIdentifier !== "string" || item.serverIdentifier.length === 0) return null;
  if (!isMcpServerConfig(item.config)) return null;
  return { id: item.id, name: item.name, serverIdentifier: item.serverIdentifier, config: item.config };
}

function parseInstall(value: unknown): LocalMcpInstall | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.pluginId !== "string" || !/^\d+$/.test(item.pluginId)) return null;
  if (typeof item.displayName !== "string" || item.displayName.length === 0) return null;
  if (!Array.isArray(item.servers)) return null;
  const servers = item.servers.map(parseServer).filter((server): server is LocalMcpInstallServer => server != null);
  if (servers.length === 0) return null;
  return { pluginId: item.pluginId, displayName: item.displayName, servers };
}

export function parseLocalMcpInstalls(value: unknown): LocalMcpInstall[] {
  if (!Array.isArray(value)) return [];
  const byPlugin = new Map<string, LocalMcpInstall>();
  for (const item of value) {
    const parsed = parseInstall(item);
    if (parsed != null) byPlugin.set(parsed.pluginId, parsed);
  }
  return [...byPlugin.values()];
}

export function readLocalMcpInstalls(settingsPath: string): LocalMcpInstall[] {
  const target = localMcpInstallsPath(settingsPath);
  if (!existsSync(target)) return [];
  try {
    return parseLocalMcpInstalls(JSON.parse(readFileSync(target, "utf8")) as unknown);
  } catch {
    return [];
  }
}

export function writeLocalMcpInstalls(settingsPath: string, installs: readonly LocalMcpInstall[]): void {
  const target = localMcpInstallsPath(settingsPath);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(installs, null, 2), "utf8");
  renameSync(temp, target);
}

export function applyInstallValues(
  servers: Record<string, McpServerConfig>,
  values: Readonly<Record<string, string>>,
): Record<string, McpServerConfig> {
  const entries = Object.entries(values).filter(([key]) => /^[A-Za-z0-9_]+$/.test(key));
  if (entries.length === 0) return servers;
  let raw = JSON.stringify(servers);
  for (const [key, value] of entries) {
    raw = raw.replaceAll(`\${${key}}`, JSON.stringify(value).slice(1, -1));
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return servers;
    const next: Record<string, McpServerConfig> = {};
    for (const [name, config] of Object.entries(parsed)) if (isMcpServerConfig(config)) next[name] = config;
    return Object.keys(next).length > 0 ? next : servers;
  } catch {
    return servers;
  }
}

export function nextLocalServerId(existing: readonly { readonly id: string }[]): string {
  let max = LOCAL_ID_START - 1;
  for (const row of existing) {
    if (!/^[1-9]\d*$/.test(row.id)) continue;
    const n = Number(row.id);
    if (Number.isSafeInteger(n) && n >= LOCAL_ID_START && n > max) max = n;
  }
  return String(max + 1);
}

export function displayServersFromLocalInstalls(installs: readonly LocalMcpInstall[]): DisplayServer[] {
  return installs.flatMap((install) => install.servers.map((server) => ({
    id: server.id,
    name: server.name,
    serverIdentifier: server.serverIdentifier,
    config: server.config,
    isTeamServer: false,
    disabledByTeamAdminPolicy: false,
    pluginId: install.pluginId,
  })));
}

export function settingsPathOf(store: { readonly settingsPath?: unknown } | null | undefined): string | null {
  return typeof store?.settingsPath === "string" && store.settingsPath.length > 0 ? store.settingsPath : null;
}

export function displayFromSettingsStore(store: { readonly settingsPath?: unknown } | null | undefined): AccountDisplayConfig | null {
  const settingsPath = settingsPathOf(store);
  if (settingsPath == null) return null;
  const servers = displayServersFromLocalInstalls(readLocalMcpInstalls(settingsPath));
  if (servers.length === 0) return null;
  return { servers, cacheScope: LOCAL_MCP_CACHE_SCOPE };
}

export function mergeLocalInstallDisplay(
  display: AccountDisplayConfig | null,
  store: { readonly settingsPath?: unknown } | null | undefined,
): AccountDisplayConfig | null {
  const local = displayFromSettingsStore(store);
  if (display == null) return local;
  if (local == null) return display;
  const seen = new Set(display.servers.map((server) => server.id));
  return { ...display, servers: [...display.servers, ...local.servers.filter((server) => !seen.has(server.id))] };
}

export function upsertLocalPluginInstall(args: {
  readonly settingsPath: string;
  readonly plugin: Pick<SandMarketplacePlugin, "pluginId" | "displayName">;
  readonly servers: Record<string, McpServerConfig>;
  readonly values?: Readonly<Record<string, string>>;
}): LocalMcpInstall[] {
  const applied = applyInstallValues(args.servers, args.values ?? {});
  const names = Object.keys(applied);
  if (names.length === 0) {
    throw new SandMcpConfigError(
      `Couldn't load "${args.plugin.displayName}" without a Cursor account. The marketplace did not publish a public MCP config.`,
    );
  }
  const current = readLocalMcpInstalls(args.settingsPath).filter((install) => install.pluginId !== args.plugin.pluginId);
  const existingIds = current.flatMap((install) => install.servers);
  const servers: LocalMcpInstallServer[] = [];
  for (const name of names) {
    const config = applied[name]!;
    servers.push({
      id: nextLocalServerId([...existingIds, ...servers]),
      name,
      serverIdentifier: name,
      config,
    });
  }
  const next = [...current, { pluginId: args.plugin.pluginId, displayName: args.plugin.displayName, servers }];
  writeLocalMcpInstalls(args.settingsPath, next);
  return next;
}

export function removeLocalPluginInstall(settingsPath: string, pluginId: string): boolean {
  const current = readLocalMcpInstalls(settingsPath);
  const next = current.filter((install) => install.pluginId !== pluginId);
  if (next.length === current.length) return false;
  writeLocalMcpInstalls(settingsPath, next);
  return true;
}

export function toRawGithubPluginUrl(blobUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(blobUrl);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || parts[2] !== "blob") return null;
  const [owner, repo, , ref, ...rest] = parts;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
}

function isObjectConfig(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

export async function fetchPublicPluginServers(
  plugin: SandMarketplacePlugin,
  _token?: unknown,
  _getMachineId?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, McpServerConfig>> {
  for (const sourceUrl of plugin.sourceUrls) {
    const raw = toRawGithubPluginUrl(sourceUrl);
    if (raw == null) continue;
    try {
      const response = await fetchImpl(raw);
      if (!response.ok) continue;
      const text = await response.text();
      const parsed: unknown = JSON.parse(text);
      const candidate = isObjectConfig(parsed) && isObjectConfig(parsed.mcpServers) ? parsed.mcpServers : parsed;
      if (!isObjectConfig(candidate)) continue;
      const servers: Record<string, McpServerConfig> = {};
      for (const [name, value] of Object.entries(candidate)) {
        if (!isObjectConfig(value)) continue;
        const { transport, ...rest } = value;
        if (typeof transport === "string" && rest.type == null) {
          if (transport === "sse") rest.type = "sse";
          else if (transport === "http" || transport === "streamableHttp") rest.type = "http";
        }
        if (typeof rest.command === "string" && rest.command.length > 0) servers[name] = rest as McpServerConfig;
        else if (typeof rest.url === "string" && rest.url.length > 0) servers[name] = rest as McpServerConfig;
      }
      if (Object.keys(servers).length > 0) return servers;
    } catch {}
  }
  return {};
}

export async function installFromCatalog(args: {
  readonly plugin: SandMarketplacePlugin;
  readonly values?: Readonly<Record<string, string>>;
  readonly token: unknown;
  readonly core: {
    bestEffortToken(token: unknown): Promise<unknown>;
    requireAccountWriter(): { installPlugin(request: { pluginId: bigint; variables?: Record<string, string> }): Promise<unknown> };
    getMachineId: unknown;
    fetchPluginServers?: (
      plugin: SandMarketplacePlugin,
      token: unknown,
      getMachineId: unknown,
    ) => Promise<Record<string, McpServerConfig>>;
    settingsPath?: string;
    settingsStore?: { readonly settingsPath?: unknown };
  };
}): Promise<"cursor" | "local"> {
  if ((await args.core.bestEffortToken(args.token)) != null) {
    await args.core.requireAccountWriter().installPlugin({
      pluginId: BigInt(args.plugin.pluginId),
      ...(args.values == null ? {} : { variables: { ...args.values } }),
    });
    return "cursor";
  }
  const settingsPath = args.core.settingsPath ?? settingsPathOf(args.core.settingsStore);
  if (settingsPath == null) {
    throw new SandMcpConfigError("Managing MCP servers requires a signed-in Cursor account.");
  }
  await installMarketplaceEntryWithoutCursorAccount({
    plugin: args.plugin,
    ...(args.values == null ? {} : { values: args.values }),
    token: args.token,
    getMachineId: args.core.getMachineId,
    settingsPath,
    fetchPluginServers: args.core.fetchPluginServers ?? fetchPublicPluginServers,
  });
  return "local";
}

export async function installMarketplaceEntryWithoutCursorAccount(args: {
  readonly plugin: SandMarketplacePlugin;
  readonly values?: Readonly<Record<string, string>>;
  readonly token: unknown;
  readonly getMachineId: unknown;
  readonly settingsPath: string;
  readonly fetchPluginServers: (
    plugin: SandMarketplacePlugin,
    token: unknown,
    getMachineId: unknown,
  ) => Promise<Record<string, McpServerConfig>>;
}): Promise<LocalMcpInstall[]> {
  const servers = await args.fetchPluginServers(args.plugin, args.token, args.getMachineId);
  return upsertLocalPluginInstall({
    settingsPath: args.settingsPath,
    plugin: args.plugin,
    servers,
    ...(args.values == null ? {} : { values: args.values }),
  });
}
