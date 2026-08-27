/** Same image string as LOCAL_DOCKER_BOX_IMAGE in local-docker-host-connector.ts. */
export const SELF_HOST_BOX_IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest";
export const SELF_HOST_BOX_CONTAINER = "openbot-self-host";
export const SELF_HOST_SCHEMA_VERSION = "1";
export const SELF_HOST_OWNER_LABEL = "com.openbot.self-host=1";
export const SELF_HOST_REMOTE_DIRNAME = "openbot-box";
export const SELF_HOST_DEFAULT_GATEWAY_PORT = 1340;
export const SELF_HOST_DEFAULT_SSH_PORT = 22;
export const SELF_HOST_CREDENTIAL_FILENAME = "self-host-gateway.json";
export const SELF_HOST_KNOWN_HOSTS_FILENAME = "self-host-known-hosts.json";
export const DOCKER_ENGINE_INSTALL_URL = "https://docs.docker.com/engine/install/";

const SCRIPT_ROOT_PLACEHOLDER = "/.__openbot_home_root__";

export interface SelfHostInstallParams {
  readonly token: string;
  readonly gatewayPort: number;
  readonly remoteRoot?: string;
  readonly tlsCertPath?: string;
  readonly tlsKeyPath?: string;
}

/** Files go under the SSH user's home: `$HOME/openbot-box`. */
export function selfHostRemoteRoot(homeDir: string): string {
  const home = homeDir.trim().replace(/\/+$/, "");
  if (home.length === 0 || !home.startsWith("/")) throw new Error("HOME is empty.");
  return `${home}/${SELF_HOST_REMOTE_DIRNAME}`;
}

export function selfHostRemoteHostMainPath(root: string): string {
  return `${root}/host-main.cjs`;
}

export function selfHostRemoteBoxExecDir(root: string): string {
  return `${root}/box-exec-daemon`;
}

/** Last non-empty line from Docker/SSH output, clipped for the Install button. */
export function selfHostVisibleProgressLine(chunk: string, maxLength = 96): string | null {
  const cleaned = chunk.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const parts = cleaned.split(/\r|\n/).map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const line = parts[parts.length - 1] ?? "";
  if (line.length <= maxLength) return line;
  return `${line.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Docker argv used on the Linux box. Bind and publish match the local VM recipe,
 * except the gateway port is published on 0.0.0.0 so other machines can reach it.
 */
export function selfHostDockerRunArgs(params: SelfHostInstallParams & { readonly remoteRoot: string }): readonly string[] {
  const tls = params.tlsCertPath != null && params.tlsKeyPath != null
    ? [
      "--env", `SAND_GATEWAY_TLS_CERT=${params.tlsCertPath}`,
      "--env", `SAND_GATEWAY_TLS_KEY=${params.tlsKeyPath}`,
    ]
    : [];
  return [
    "run", "--detach", "--name", SELF_HOST_BOX_CONTAINER,
    "--label", SELF_HOST_OWNER_LABEL,
    "--label", `com.openbot.self-host.schema-version=${SELF_HOST_SCHEMA_VERSION}`,
    "--platform", "linux/amd64", "--restart", "unless-stopped",
    "--env", "SAND_SUPERVISOR_ENABLED=1",
    "--env", "SAND_BOX_AUTO_UPDATE=0",
    "--env", "SAND_USE_EXISTING_BOX_EXEC_DAEMON=1",
    "--env", "SAND_TREE_SITTER_NODE_DEPS=/home/box/deps",
    "--env", "NODE_PATH=/home/box/deps",
    "--env", "SAND_GATEWAY_BIND_HOST=0.0.0.0",
    "--env", `SAND_HOST_PORT=${params.gatewayPort}`,
    "--env", `SAND_GATEWAY_TOKEN=${params.token}`,
    ...tls,
    "--publish", `0.0.0.0:${params.gatewayPort}:${params.gatewayPort}`,
    "--volume", "openbot-self-host-workspace:/workspace",
    "--volume", "openbot-self-host-data:/home/box/sand-data",
    "--mount", `type=bind,src=${selfHostRemoteHostMainPath(params.remoteRoot)},dst=/home/box/sand-host/host-main.cjs,readonly`,
    "--mount", `type=bind,src=${selfHostRemoteBoxExecDir(params.remoteRoot)},dst=/home/box/box-exec-daemon,readonly`,
    SELF_HOST_BOX_IMAGE,
  ];
}

export function selfHostInstallScript(params: SelfHostInstallParams): string {
  const knownRoot = params.remoteRoot;
  const args = selfHostDockerRunArgs({ ...params, remoteRoot: knownRoot ?? SCRIPT_ROOT_PLACEHOLDER });
  const quoted = args.map((part) => {
    if (knownRoot == null && part.includes(SCRIPT_ROOT_PLACEHOLDER)) {
      return `"${part.replaceAll(SCRIPT_ROOT_PLACEHOLDER, "${ROOT}")}"`;
    }
    return shQuote(part);
  }).join(" ");
  const rootLine = knownRoot == null ? `ROOT="\${HOME}/${SELF_HOST_REMOTE_DIRNAME}"` : `ROOT=${shQuote(knownRoot)}`;
  return [
    "#!/bin/sh",
    "set -eu",
    rootLine,
    "if ! command -v docker >/dev/null 2>&1; then",
    `  echo "docker is not installed" >&2`,
    `  echo "${DOCKER_ENGINE_INSTALL_URL}" >&2`,
    "  exit 1",
    "fi",
    "if docker ps >/dev/null 2>&1; then DOCKER=docker",
    'elif sudo -n docker ps >/dev/null 2>&1; then DOCKER="sudo docker"',
    "else",
    '  echo "This user cannot run Docker. Add them to the docker group, then log in again." >&2',
    "  exit 1",
    "fi",
    'mkdir -p "${ROOT}/box-exec-daemon"',
    'echo "Checking Docker…"',
    `$DOCKER rm --force ${shQuote(SELF_HOST_BOX_CONTAINER)} >/dev/null 2>&1 || true`,
    'echo "Pulling image…"',
    `$DOCKER pull ${shQuote(SELF_HOST_BOX_IMAGE)}`,
    'echo "Starting container…"',
    `$DOCKER ${quoted}`,
  ].join("\n");
}

export function selfHostOneLiner(params: SelfHostInstallParams): string {
  return `sh -c ${shQuote(selfHostInstallScript(params))}`;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
