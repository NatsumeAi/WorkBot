import { readFile } from "node:fs/promises";
import { Client as Ssh2Client } from "ssh2";
import { fingerprintSha256, readKnownHost, writeKnownHost } from "./self-host-credentials.js";

interface SshStream {
  on(event: "data", listener: (chunk: Buffer) => void): SshStream;
  on(event: "close", listener: (code: number | null) => void): SshStream;
  stderr?: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
}

interface SftpClient {
  fastPut(localPath: string, remotePath: string, callback: (error?: Error) => void): void;
}

interface SshClient {
  on(event: "ready", listener: () => void): SshClient;
  on(event: "error", listener: (error: Error) => void): SshClient;
  connect(config: Record<string, unknown>): SshClient;
  exec(
    command: string,
    options: Record<string, unknown>,
    callback: (error: Error | undefined, stream: SshStream) => void,
  ): void;
  sftp(callback: (error: Error | undefined, sftp: SftpClient) => void): void;
  forwardOut(srcIP: string, srcPort: number, dstIP: string, dstPort: number, callback: (error: Error | undefined, stream: unknown) => void): void;
  end(): void;
}

export interface SelfHostSshTarget {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password?: string;
  readonly privateKeyPath?: string;
  readonly passphrase?: string;
}

export interface SelfHostExecOptions {
  readonly onOutput?: (chunk: string) => void;
  readonly timeoutMs?: number;
}

export interface SelfHostSshSession {
  exec(command: string, options?: SelfHostExecOptions): Promise<{ code: number | null; stdout: string; stderr: string }>;
  mkdirp(remotePath: string): Promise<void>;
  putFile(localPath: string, remotePath: string): Promise<void>;
  end(): void;
}

export class SelfHostNeedHostConfirmError extends Error {
  readonly fingerprintSha256: string;
  readonly host: string;
  readonly port: number;
  constructor(args: { host: string; port: number; fingerprintSha256: string }) {
    super("Confirm this server's host key to continue.");
    this.name = "SelfHostNeedHostConfirmError";
    this.host = args.host;
    this.port = args.port;
    this.fingerprintSha256 = args.fingerprintSha256;
  }
}

export class SelfHostHostKeyChangedError extends Error {
  constructor() {
    super("Host key changed.");
    this.name = "SelfHostHostKeyChangedError";
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function authFields(target: SelfHostSshTarget): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = { username: target.username };
  if (target.privateKeyPath != null && target.privateKeyPath.length > 0) {
    fields.privateKey = await readFile(target.privateKeyPath);
    if (target.passphrase != null && target.passphrase.length > 0) fields.passphrase = target.passphrase;
  } else if (target.password != null && target.password.length > 0) {
    fields.password = target.password;
  } else {
    throw new Error("Enter a password or choose a key file.");
  }
  return fields;
}

async function connectClient(config: Record<string, unknown>, pending: { error?: Error }): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const client = new Ssh2Client() as unknown as SshClient;
    const fail = (error: unknown): void => {
      try { client.end(); } catch { /* already closed */ }
      reject(pending.error ?? asError(error));
    };
    client.on("ready", () => resolve(client));
    client.on("error", fail);
    try {
      client.connect(config);
    } catch (error) {
      fail(error);
    }
  });
}

async function verifierConfig(
  settingsPath: string,
  target: SelfHostSshTarget,
  acceptHostKey: boolean,
  pending: { error?: Error },
): Promise<{ hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => boolean | void }> {
  const known = await readKnownHost(settingsPath, target.host, target.port);
  return {
    hostVerifier: (key: Buffer, verify: (ok: boolean) => void): boolean | void => {
      const fingerprint = fingerprintSha256(key);
      if (known == null) {
        if (!acceptHostKey) {
          pending.error = new SelfHostNeedHostConfirmError({ host: target.host, port: target.port, fingerprintSha256: fingerprint });
          return false;
        }
        void writeKnownHost(settingsPath, target.host, target.port, fingerprint).then(
          () => verify(true),
          (error: unknown) => {
            pending.error = asError(error);
            verify(false);
          },
        );
        return;
      }
      if (known.fingerprintSha256 !== fingerprint) {
        pending.error = new SelfHostHostKeyChangedError();
        return false;
      }
      return true;
    },
  };
}

function sessionFromClient(client: SshClient): SelfHostSshSession {
  const exec = (command: string, options?: SelfHostExecOptions): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((resolve, reject) => {
    client.exec(command, {}, (error, stream) => {
      if (error) { reject(error); return; }
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = options?.timeoutMs != null && options.timeoutMs > 0
        ? setTimeout(() => {
          if (settled) return;
          settled = true;
          try { stream.close(); } catch { /* already closed */ }
          reject(new Error("That step timed out. Docker pull may be stuck; run it on the server, then Install again."));
        }, options.timeoutMs)
        : null;
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        resolve({ code, stdout, stderr });
      };
      const take = (chunk: Buffer, which: "stdout" | "stderr"): void => {
        const text = chunk.toString();
        if (which === "stdout") {
          stdout += text;
          if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
        } else {
          stderr += text;
          if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
        }
        options?.onOutput?.(text);
      };
      stream.on("data", (chunk: Buffer) => { take(chunk, "stdout"); });
      stream.stderr?.on("data", (chunk: Buffer) => { take(chunk, "stderr"); });
      stream.on("close", (code: number | null) => finish(code));
    });
  });
  return {
    exec,
    async mkdirp(remotePath: string): Promise<void> {
      const result = await exec(`mkdir -p ${shellSingleQuote(remotePath)}`);
      if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not create ${remotePath}.`);
    },
    async putFile(localPath: string, remotePath: string): Promise<void> {
      const handle = await new Promise<SftpClient>((resolve, reject) => {
        client.sftp((error, sftp) => { if (error || sftp == null) reject(error ?? new Error("SFTP is unavailable.")); else resolve(sftp); });
      });
      await new Promise<void>((resolve, reject) => {
        handle.fastPut(localPath, remotePath, (error) => { if (error) reject(error); else resolve(); });
      });
    },
    end: () => { client.end(); },
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function openSelfHostSshSession(args: {
  readonly settingsPath: string;
  readonly target: SelfHostSshTarget;
  readonly jump?: SelfHostSshTarget;
  readonly acceptHostKey: boolean;
}): Promise<SelfHostSshSession> {
  const targetAuth = await authFields(args.target);
  if (args.jump == null) {
    const pending: { error?: Error } = {};
    const client = await connectClient({
      host: args.target.host,
      port: args.target.port,
      readyTimeout: 20_000,
      ...(await verifierConfig(args.settingsPath, args.target, args.acceptHostKey, pending)),
      ...targetAuth,
    }, pending);
    return sessionFromClient(client);
  }

  const jumpAuth = await authFields(args.jump);
  const jumpPending: { error?: Error } = {};
  const jump = await connectClient({
    host: args.jump.host,
    port: args.jump.port,
    readyTimeout: 20_000,
    ...(await verifierConfig(args.settingsPath, args.jump, args.acceptHostKey, jumpPending)),
    ...jumpAuth,
  }, jumpPending);
  try {
    const stream = await new Promise<unknown>((resolve, reject) => {
      jump.forwardOut("127.0.0.1", 0, args.target.host, args.target.port, (error, forwarded) => {
        if (error || forwarded == null) reject(error ?? new Error("Can't reach that server."));
        else resolve(forwarded);
      });
    });
    const targetPending: { error?: Error } = {};
    const client = await connectClient({
      sock: stream,
      readyTimeout: 20_000,
      ...(await verifierConfig(args.settingsPath, args.target, args.acceptHostKey, targetPending)),
      ...targetAuth,
    }, targetPending);
    const session = sessionFromClient(client);
    const innerEnd = session.end;
    return { ...session, end: () => { innerEnd(); jump.end(); } };
  } catch (error) {
    jump.end();
    throw error;
  }
}

export function classifySelfHostSshError(error: unknown): string {
  if (error instanceof SelfHostNeedHostConfirmError) return error.message;
  if (error instanceof SelfHostHostKeyChangedError) return error.message;
  const err = asError(error);
  const code = "code" in err ? String((err as { code?: unknown }).code) : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EHOSTUNREACH") {
    return "Can't reach that server.";
  }
  const message = err.message.toLowerCase();
  if (message.includes("authentication") || message.includes("all configured authentication methods failed")) {
    return "Wrong username, password, or key.";
  }
  if (message.includes("host key changed")) return "Host key changed.";
  return err.message;
}
