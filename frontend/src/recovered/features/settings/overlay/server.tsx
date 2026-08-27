import { useEffect, useState } from "react";
import { SandButton } from "../../../ui/sand-kit-primitives";
import type { AgentDesktopBridge } from "../../../contracts/desktop-bridge";

export interface ServerSettingsPanelProps {
  agent: AgentDesktopBridge;
}

type ConfirmHost = { host: string; port: number; fingerprintSha256: string };

export function ServerSettingsPanel({ agent }: ServerSettingsPanelProps) {
  const [host, setHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [jumpHost, setJumpHost] = useState("");
  const [jumpPort, setJumpPort] = useState("22");
  const [jumpUser, setJumpUser] = useState("");
  const [jumpPassword, setJumpPassword] = useState("");
  const [accessUrl, setAccessUrl] = useState("");
  const [gatewayPort, setGatewayPort] = useState("1340");
  const [tlsCert, setTlsCert] = useState("");
  const [tlsKey, setTlsKey] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmHost | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [oneLiner, setOneLiner] = useState("");
  const [envOverrides, setEnvOverrides] = useState(false);
  const [dockerUrl, setDockerUrl] = useState("https://docs.docker.com/engine/install/");

  useEffect(() => {
    let active = true;
    void agent.getSelfHostConnection().then((connection) => {
      if (!active) return;
      setEnvOverrides(connection.envOverrides);
      if (connection.gatewayUrl.length > 0) setAccessUrl(connection.gatewayUrl);
      setGatewayPort(String(connection.defaultGatewayPort));
      setSshPort(String(connection.defaultSshPort));
      setDockerUrl(connection.dockerInstallUrl);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    const stop = agent.onSelfHostInstallProgress((payload) => {
      if (typeof payload.line === "string") setProgress(payload.line);
    });
    return () => { active = false; stop(); };
  }, [agent]);

  const payload = (extra: Record<string, unknown> = {}) => ({
    host,
    port: Number(sshPort),
    username,
    ...(password.length > 0 ? { password } : {}),
    ...(keyPath.length > 0 ? { privateKeyPath: keyPath } : {}),
    ...(jumpHost.trim().length > 0 && jumpUser.trim().length > 0 ? {
      jump: {
        host: jumpHost.trim(),
        port: Number(jumpPort),
        username: jumpUser.trim(),
        ...(jumpPassword.length > 0 ? { password: jumpPassword } : {}),
      },
    } : {}),
    gatewayPort: Number(gatewayPort),
    ...(accessUrl.trim().length > 0 ? { accessUrl: accessUrl.trim() } : {}),
    ...(tlsCert.trim().length > 0 ? { tlsCertPath: tlsCert.trim() } : {}),
    ...(tlsKey.trim().length > 0 ? { tlsKeyPath: tlsKey.trim() } : {}),
    ...extra,
  });

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await action(); } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  const install = (acceptHostKey: boolean) => run(async () => {
    const result = await agent.installSelfHostBox(payload({ acceptHostKey })) as {
      status?: string;
      message?: string;
      gatewayUrl?: string;
      fingerprintSha256?: string;
      host?: string;
      port?: number;
      dockerInstallUrl?: string;
    };
    if (result.status === "confirm-host" && result.fingerprintSha256 != null && result.host != null && result.port != null) {
      setConfirm({ host: result.host, port: result.port, fingerprintSha256: result.fingerprintSha256 });
      return;
    }
    if (result.status === "error") {
      setError(result.message ?? "Install failed.");
      if (result.dockerInstallUrl != null) setDockerUrl(result.dockerInstallUrl);
      return;
    }
    setConfirm(null);
    if (typeof result.gatewayUrl === "string") setAccessUrl(result.gatewayUrl);
    setNotice("Installed.");
    setPassword("");
    setJumpPassword("");
  });

  return (
    <div className="sand-server-section">
      <section>
        <h3>Server</h3>
        {envOverrides ? <p className="sand-settings-field__hint">Environment variables are set on this computer, so they still win.</p> : null}
        <label title="Hostname or IP of the Linux box">
          <span>Server</span>
          <input aria-label="Server" onChange={(event) => setHost(event.currentTarget.value)} value={host} />
        </label>
        <label title="SSH port on that machine">
          <span>SSH port</span>
          <input aria-label="SSH port" onChange={(event) => setSshPort(event.currentTarget.value)} value={sshPort} />
        </label>
        <label>
          <span>Username</span>
          <input aria-label="Username" onChange={(event) => setUsername(event.currentTarget.value)} value={username} />
        </label>
        <label>
          <span>Password</span>
          <input aria-label="Password" onChange={(event) => setPassword(event.currentTarget.value)} type="password" value={password} />
        </label>
        <div className="sand-settings-row">
          <span className="sand-settings-copy"><strong>Key file</strong><small>{keyPath || "Optional if you use a password"}</small></span>
          <SandButton disabled={busy} onClick={() => void run(async () => {
            const picked = await agent.pickSelfHostKeyFile();
            if (picked != null) setKeyPath(picked);
          })} size="sm" variant="secondary">Choose</SandButton>
        </div>
        <label title="Leave blank unless you need a jump host">
          <span>Jump host</span>
          <input aria-label="Jump host" onChange={(event) => setJumpHost(event.currentTarget.value)} value={jumpHost} />
        </label>
        <label>
          <span>Jump port</span>
          <input aria-label="Jump port" onChange={(event) => setJumpPort(event.currentTarget.value)} value={jumpPort} />
        </label>
        <label>
          <span>Jump user</span>
          <input aria-label="Jump user" onChange={(event) => setJumpUser(event.currentTarget.value)} value={jumpUser} />
        </label>
        <label>
          <span>Jump password</span>
          <input aria-label="Jump password" onChange={(event) => setJumpPassword(event.currentTarget.value)} type="password" value={jumpPassword} />
        </label>
        <label title="URL this app will use after install">
          <span>Access URL</span>
          <input aria-label="Access URL" onChange={(event) => setAccessUrl(event.currentTarget.value)} value={accessUrl} />
        </label>
        <label>
          <span>Gateway port</span>
          <input aria-label="Gateway port" onChange={(event) => setGatewayPort(event.currentTarget.value)} value={gatewayPort} />
        </label>
        <label title="Optional TLS certificate path">
          <span>Certificate</span>
          <input aria-label="Certificate" onChange={(event) => setTlsCert(event.currentTarget.value)} value={tlsCert} />
        </label>
        <label title="Optional TLS key path">
          <span>Certificate key</span>
          <input aria-label="Certificate key" onChange={(event) => setTlsKey(event.currentTarget.value)} value={tlsKey} />
        </label>
        <label>
          <span>Token</span>
          <input aria-label="Token" onChange={(event) => setToken(event.currentTarget.value)} type="password" value={token} />
        </label>
        {confirm ? (
          <div className="sand-settings-row">
            <span className="sand-settings-copy">
              <strong>Confirm host key</strong>
              <small>{confirm.host}:{confirm.port} {confirm.fingerprintSha256}</small>
            </span>
            <SandButton disabled={busy} onClick={() => void install(true)} size="sm" variant="primary">Confirm</SandButton>
          </div>
        ) : null}
        <div className="sand-usage-actions">
          <SandButton disabled={busy} onClick={() => void install(confirm != null)} size="md" variant="primary">{busy ? (progress || "Working…") : "Install"}</SandButton>
          <SandButton disabled={busy} onClick={() => void run(async () => {
            const saved = await agent.setSelfHostConnection({
              gatewayUrl: accessUrl.trim(),
              ...(token.trim().length > 0 ? { token: token.trim() } : {}),
            });
            if (saved.hasToken !== true || saved.gatewayUrl.length === 0) {
              setError("Enter an access URL and token.");
              return;
            }
            const tested = await agent.testSelfHostGateway({ gatewayUrl: saved.gatewayUrl, ...(token.trim().length > 0 ? { token: token.trim() } : {}) });
            if (!tested.ok) { setError(tested.message); return; }
            setNotice(tested.message);
            setToken("");
          })} size="md" variant="secondary">Connect</SandButton>
        </div>
        <p><button className="sand-settings-docs-link" onClick={() => void agent.openSelfHostDocs()} type="button">Learn more</button></p>
        {error ? <p className="sand-account__error">{error}{error.includes("Docker") ? <> <a href={dockerUrl} rel="noreferrer" target="_blank">Docker install</a></> : null}</p> : null}
        {notice ? <p className="sand-settings-field__hint">{notice}</p> : null}
      </section>
      <section>
        <h3>Advanced</h3>
        <SandButton disabled={busy} onClick={() => void run(async () => {
          const next = !advanced;
          setAdvanced(next);
          if (next) {
            const generated = await agent.getSelfHostInstallCommand({
              gatewayPort: Number(gatewayPort),
              ...(tlsCert.trim().length > 0 && tlsKey.trim().length > 0 ? { tlsCertPath: tlsCert.trim(), tlsKeyPath: tlsKey.trim() } : {}),
            });
            setOneLiner(generated.command);
          }
        })} size="sm" variant="secondary">{advanced ? "Hide command" : "Show command"}</SandButton>
        {advanced ? <textarea aria-label="Install command" readOnly rows={8} value={oneLiner} /> : null}
      </section>
    </div>
  );
}
