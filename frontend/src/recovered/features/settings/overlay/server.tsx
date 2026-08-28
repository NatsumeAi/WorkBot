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
  const [status, setStatus] = useState<"missing" | "saved" | "connected">("missing");
  const [statusMessage, setStatusMessage] = useState("Not connected.");
  const [hasToken, setHasToken] = useState(false);
  const [proxyMode, setProxyMode] = useState<"off" | "custom">("off");
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyUsing, setProxyUsing] = useState(false);
  const [proxyBusy, setProxyBusy] = useState(false);

  const loadConnection = () => agent.getSelfHostConnection().then((connection) => {
    setEnvOverrides(connection.envOverrides);
    if (connection.gatewayUrl.length > 0) setAccessUrl(connection.gatewayUrl);
    if (connection.host) setHost(connection.host);
    if (connection.username) setUsername(connection.username);
    setGatewayPort(String(connection.gatewayPort ?? connection.defaultGatewayPort));
    setSshPort(String(connection.sshPort ?? connection.defaultSshPort));
    setDockerUrl(connection.dockerInstallUrl);
    setHasToken(connection.hasToken === true);
    setStatus(connection.status ?? (connection.gatewayUrl ? "saved" : "missing"));
    setStatusMessage(connection.statusMessage ?? (connection.gatewayUrl ? "Saved." : "Not connected."));
  });

  useEffect(() => {
    let active = true;
    void loadConnection().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    const stop = agent.onSelfHostInstallProgress((payload) => {
      if (typeof payload.line === "string") setProgress(payload.line);
    });
    void agent.getOutboundProxy().then((proxy) => {
      if (!active) return;
      setProxyMode(proxy.mode === "custom" ? "custom" : "off");
      setProxyUrl(proxy.customUrl || "");
      setProxyUsing(proxy.usingProxy === true);
    }).catch(() => {});
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
    await loadConnection();
  });

  return (
    <div className="sand-server-section">
      <section>
        <h3>Server</h3>
        {envOverrides ? <p className="sand-settings-field__hint">Environment variables are set on this computer, so they still win.</p> : null}
        <p className="sand-settings-field__hint">{statusMessage}{hasToken ? " Token is saved on this computer." : ""}</p>
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
          <input aria-label="Token" onChange={(event) => setToken(event.currentTarget.value)} placeholder={hasToken ? "Saved" : undefined} type="password" value={token} />
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
          <SandButton disabled={busy} onClick={() => void install(confirm != null)} size="md" variant="primary">{busy ? (progress || "Connecting…") : "Install"}</SandButton>
          <SandButton disabled={busy} onClick={() => void run(async () => {
            const saved = await agent.setSelfHostConnection({
              gatewayUrl: accessUrl.trim(),
              host: host.trim(),
              username: username.trim(),
              port: Number(sshPort),
              gatewayPort: Number(gatewayPort),
              ...(token.trim().length > 0 ? { token: token.trim() } : {}),
            });
            if (saved.hasToken !== true || saved.gatewayUrl.length === 0) {
              setError(saved.message ?? "Enter an access URL and token.");
              return;
            }
            setNotice(saved.statusMessage ?? "Saved.");
            setStatus((saved.status as "missing" | "saved" | "connected") || "saved");
            setStatusMessage(saved.statusMessage ?? "Saved.");
            setHasToken(true);
            if (saved.gatewayUrl) setAccessUrl(saved.gatewayUrl);
            setToken("");
          })} size="md" variant="secondary">Connect</SandButton>
        </div>
        <p><button className="sand-settings-docs-link" onClick={() => void agent.openSelfHostDocs()} type="button">Learn more</button></p>
        {busy && progress ? <p className="sand-settings-field__hint">{progress}</p> : null}
        {error ? <p className="sand-account__error">{error}{error.includes("Docker") ? <> <a href={dockerUrl} rel="noreferrer" target="_blank">Docker install</a></> : null}</p> : null}
        {notice ? <p className="sand-settings-field__hint">{notice}</p> : null}
      </section>
      <section>
        <h3>Outbound proxy</h3>
        <p className="sand-settings-field__hint">Off is direct. Custom sends public APIs through the URL you paste. 127.0.0.1 is always direct.</p>
        <label>
          <span>Mode<small>{proxyMode === "custom" ? "Paste a proxy URL. 127.0.0.1 stays direct." : "Direct. Local 127 APIs work without a proxy."}</small></span>
          <select aria-label="Outbound proxy mode" onChange={(event) => setProxyMode(event.currentTarget.value === "custom" ? "custom" : "off")} value={proxyMode}>
            <option value="off">Off</option>
            <option value="custom">Custom URL</option>
          </select>
        </label>
        {proxyMode === "custom" ? (
          <label title="http://host:port or http://user:pass@host:port">
            <span>Proxy URL</span>
            <input aria-label="Proxy URL" onChange={(event) => setProxyUrl(event.currentTarget.value)} value={proxyUrl} />
          </label>
        ) : null}
        <SandButton disabled={busy || proxyBusy} onClick={() => void run(async () => {
          setProxyBusy(true);
          try {
            const saved = await agent.setOutboundProxy({ mode: proxyMode === "custom" ? "custom" : "off", customUrl: proxyUrl || "" });
            setProxyMode(saved.mode === "custom" ? "custom" : "off");
            setProxyUrl(saved.customUrl || "");
            setProxyUsing(saved.usingProxy === true);
            setNotice(saved.usingProxy ? "Outbound proxy is on. 127.0.0.1 stays direct." : "Outbound proxy is off.");
          } finally {
            setProxyBusy(false);
          }
        })} size="sm" variant="primary">{proxyBusy ? "Saving…" : "Save proxy"}</SandButton>
        {proxyUsing ? <p className="sand-settings-field__hint">Using proxy.</p> : null}
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
