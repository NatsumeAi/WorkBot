import { useEffect, useState } from "react";
import { SandButton } from "../../../ui/sand-kit-primitives";
import { SandSelect } from "../../../ui/sand-floating-primitives";
import type { AgentDesktopBridge, DesktopBridge } from "../../../contracts/desktop-bridge";
import { nextKeyId, prepareRouterPoolSave, type RouterPoolSlot, type RouterPoolState } from "./router-pool";
import { isRouterProviderId, type RouterProviderId } from "./router";

interface CatalogProvider {
  id: string;
  label: string;
  baseURL: string;
  secret: string;
  models: readonly { id: string; label: string; context: number; maxOutput: number }[];
}

const ROUTER_OPTIONS: readonly { value: RouterProviderId; label: string }[] = [
  { value: "openrouter", label: "API" },
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
];

const EMPTY_USAGE = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastUsedAt: null as string | null };

function catalog(): CatalogProvider[] {
  return [
    { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", secret: "OPENAI_API_KEY", models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", context: 1050000, maxOutput: 128000 }, { id: "dall-e-3", label: "DALL·E 3 (image)", context: 4000, maxOutput: 1 }] },
    { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", secret: "OPENROUTER_API_KEY", models: [{ id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", context: 1050000, maxOutput: 128000 }, { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", context: 1000000, maxOutput: 128000 }] },
    { id: "anthropic", label: "Anthropic", baseURL: "https://api.anthropic.com/v1", secret: "ANTHROPIC_API_KEY", models: [{ id: "claude-opus-5", label: "Claude Opus 5", context: 1000000, maxOutput: 128000 }] },
    { id: "deepseek", label: "DeepSeek", baseURL: "https://api.deepseek.com/v1", secret: "DEEPSEEK_API_KEY", models: [{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", context: 1000000, maxOutput: 128000 }] },
    { id: "custom", label: "Custom / relay", baseURL: "https://example.invalid/v1", secret: "CUSTOM_API_KEY", models: [{ id: "model-id", label: "Model ID", context: 128000, maxOutput: 32768 }] },
  ];
}

function applyProvider(providerId: string, modelId?: string): RouterPoolSlot {
  const providers = catalog();
  const provider = providers.find((item) => item.id === providerId) ?? providers.find((item) => item.id === "custom") ?? providers[providers.length - 1]!;
  const model = modelId == null ? provider.models[0]! : provider.models.find((item) => item.id === modelId) ?? provider.models[0]!;
  return {
    id: "",
    name: model.label,
    provider: provider.id,
    baseURL: provider.baseURL,
    secret: provider.secret,
    model: model.id,
    effort: "medium",
    contextWindow: String(model.context),
    maxInput: String(Math.max(1024, Math.floor(model.context * 0.75) - model.maxOutput)),
    maxOutput: String(model.maxOutput),
    key: "",
  };
}

function slotFromEndpoint(endpoint: Record<string, unknown> | null): RouterPoolSlot {
  if (endpoint == null) return applyProvider("custom");
  const providers = catalog();
  const provider = providers.find((item) => item.baseURL === endpoint.baseURL) ?? providers[providers.length - 1]!;
  const context = Number(endpoint.contextWindow ?? provider.models[0]!.context);
  const maxOutput = Number(endpoint.maxOutputTokens ?? endpoint.maxTokens ?? provider.models[0]!.maxOutput);
  return {
    id: typeof endpoint.id === "string" ? endpoint.id : "",
    name: typeof endpoint.label === "string" ? endpoint.label : typeof endpoint.model === "string" ? endpoint.model : provider.models[0]!.label,
    provider: provider.id,
    baseURL: typeof endpoint.baseURL === "string" ? endpoint.baseURL : provider.baseURL,
    secret: typeof endpoint.apiKeySecret === "string" ? endpoint.apiKeySecret : provider.secret,
    model: typeof endpoint.model === "string" ? endpoint.model : provider.models[0]!.id,
    effort: typeof endpoint.reasoningEffort === "string" ? endpoint.reasoningEffort : "medium",
    contextWindow: String(context),
    maxInput: String(endpoint.maxInputTokens ?? Math.max(1024, Math.floor(context * 0.75) - maxOutput)),
    maxOutput: String(maxOutput),
    key: "",
  };
}

function newModelId(pool: readonly { id: string }[]): string {
  let n = 1;
  while (pool.some((item) => item.id === `model-${n}`)) n += 1;
  return `model-${n}`;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3>{title}</h3>{children}</section>;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export interface RouterSettingsPanelProps {
  agent: AgentDesktopBridge;
  secrets: DesktopBridge["secrets"];
  pending?: boolean;
  provider: RouterProviderId;
  onChange(provider: RouterProviderId): void | Promise<unknown>;
}

export function RouterSettingsPanel({ agent, secrets, pending = false, provider, onChange }: RouterSettingsPanelProps) {
  const [usage, setUsage] = useState(EMPTY_USAGE);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<{ mode: string; busy: boolean; error: string | null }>({ mode: "remote", busy: true, error: null });
  const first = (): RouterPoolSlot => ({ ...applyProvider("custom"), id: "model-1", secret: "CUSTOM_API_KEY" });
  const [pool, setPool] = useState<RouterPoolState>({
    pool: [first()],
    keys: [{ id: "CUSTOM_API_KEY", label: "Custom", key: "" }],
    chatId: "model-1",
    compactId: "",
    imageId: "",
    fallbackIds: [],
    compactAt: "0.75",
    editing: null,
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void agent.getInferenceRouter().then((result) => {
      if (!active) return;
      const endpoints = result.endpoints as { endpoints?: Record<string, unknown>[]; roles?: Record<string, unknown>; active?: string; keys?: { id?: string; label?: string }[] } | null;
      const listed = Array.isArray(endpoints?.endpoints) ? endpoints.endpoints : [];
      const currentUsage = (result.usage as { providers?: Record<string, typeof EMPTY_USAGE> } | null)?.providers?.[result.provider] ?? EMPTY_USAGE;
      setUsage({
        requests: currentUsage.requests ?? 0,
        inputTokens: currentUsage.inputTokens ?? 0,
        outputTokens: currentUsage.outputTokens ?? 0,
        cacheReadTokens: currentUsage.cacheReadTokens ?? 0,
        cacheWriteTokens: currentUsage.cacheWriteTokens ?? 0,
        lastUsedAt: currentUsage.lastUsedAt ?? null,
      });
      if (listed.length === 0) return;
      const roles = endpoints?.roles ?? {};
      const nextPool = listed.map((item, index) => {
        const slot = slotFromEndpoint(item);
        return { ...slot, id: slot.id || `model-${index + 1}` };
      });
      const chatId = (typeof roles.chat === "string" ? roles.chat : endpoints?.active) ?? nextPool[0]!.id;
      const fallbacks = Array.isArray(roles.fallbacks) ? roles.fallbacks as string[] : typeof roles.fallback === "string" ? [roles.fallback] : [];
      const keyRows: { id: string; label: string; key: string }[] = [];
      const seen = new Set<string>();
      for (const row of Array.isArray(endpoints?.keys) ? endpoints.keys : []) {
        const id = typeof row?.id === "string" ? row.id.trim() : "";
        if (id.length === 0 || seen.has(id)) continue;
        seen.add(id);
        keyRows.push({ id, label: typeof row.label === "string" && row.label.trim() ? row.label.trim() : id, key: "" });
      }
      for (const endpoint of listed) {
        const id = typeof endpoint.apiKeySecret === "string" ? endpoint.apiKeySecret.trim() : "";
        if (id.length === 0 || seen.has(id)) continue;
        seen.add(id);
        keyRows.push({ id, label: id, key: "" });
      }
      setPool((current) => ({
        ...current,
        keys: keyRows.length > 0 ? keyRows : [{ id: "CUSTOM_API_KEY", label: "Custom", key: "" }],
        pool: nextPool,
        chatId,
        compactId: typeof roles.compact === "string" && roles.compact !== chatId ? roles.compact : "",
        imageId: typeof roles.image === "string" && nextPool.some((item) => item.id === roles.image) ? roles.image : "",
        fallbackIds: fallbacks.filter((id) => nextPool.some((item) => item.id === id) && id !== chatId).slice(0, 8),
        compactAt: String((() => {
          const endpoint = listed.find((item) => item.id === chatId) ?? listed[0];
          return typeof endpoint?.compactAt === "number" ? endpoint.compactAt : 0.75;
        })()),
      }));
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    void agent.getBoxRuntime().then((result) => {
      if (active) setRuntime({ mode: result.mode, busy: false, error: null });
    }).catch((reason: unknown) => {
      if (active) setRuntime((current) => ({ ...current, busy: false, error: reason instanceof Error ? reason.message : String(reason) }));
    });
    return () => { active = false; };
  }, [agent]);

  const toggleRuntime = async () => {
    const next = runtime.mode === "local-docker" ? "remote" : "local-docker";
    setRuntime({ mode: next, busy: true, error: null });
    try {
      const result = await agent.setBoxRuntime(next);
      setRuntime({ mode: result.mode, busy: false, error: null });
    } catch (reason) {
      setRuntime({ mode: runtime.mode, busy: false, error: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  const savePool = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const prepared = prepareRouterPoolSave(pool);
      if (prepared.ok === false) throw new Error(prepared.message);
      if (Object.keys(prepared.secrets).length > 0) await secrets.upsert(prepared.secrets);
      const result = await agent.setInferenceEndpoints(prepared.document);
      if (result?.ok === false) throw new Error(result.message ?? "Could not save model pool.");
      setPool((current) => ({
        ...current,
        keys: prepared.keys.map((row) => ({ id: row.id, label: row.label, key: "" })),
        pool: prepared.pool.map((slot) => ({ ...slot, key: "" })),
        editing: null,
      }));
      setNotice("Saved on the box. Assignments apply on the next turn.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const local = runtime.mode === "local-docker";
  const poolOptions = pool.pool.map((slot) => ({ value: slot.id, label: slot.name || slot.model }));
  const compactOptions = [{ value: "", label: "Same as chat" }, ...poolOptions];
  const unusedFallbacks = pool.pool.filter((slot) => slot.id !== pool.chatId && !pool.fallbackIds.includes(slot.id));
  const editingProvider = catalog().find((item) => item.id === pool.editing?.provider) ?? catalog().find((item) => item.id === "custom")!;
  const disabled = pending || busy;

  return (
    <div className="sand-router-section">
      <Group title="Routing">
        <label>
          <span>Provider<small>API is OpenAI-compatible providers, relays, and local servers. Models pick a key from the Keys list.</small></span>
          <SandSelect
            ariaLabel="Routing provider"
            disabled={disabled}
            menuSize="md"
            onValueChange={(value) => { if (value != null && value !== provider) void onChange(value as RouterProviderId); }}
            options={ROUTER_OPTIONS}
            placement="bottom-end"
            value={provider}
          />
        </label>
      </Group>
      <Group title="Computer">
        <label>
          <span>Use local Docker VM<small>{local ? "Shell, files and computer use run in a Docker container on this computer." : "Shell, files and computer use run on Grok Bot's remote computer."}</small></span>
          <button aria-checked={local} aria-label="Use local Docker VM" disabled={runtime.busy} onClick={() => void toggleRuntime()} role="switch" type="button">{local ? "On" : "Off"}</button>
        </label>
        {runtime.error ? <div className="sand-account__error">{runtime.error}</div> : null}
      </Group>
      {provider === "openrouter" ? (
        <>
          <Group title="Keys">
            <div className="sand-settings-field__hint">A key is a named slot. Hundreds of models can share one key. Values are stored as JSON on the box.</div>
            {pool.keys.map((row) => (
              <label key={row.id}>
                <span>{row.label || row.id}<small>{row.id}</small></span>
                <span className="sand-router-inline">
                  <input aria-label="Key name" disabled={disabled} onChange={(event) => setPool((current) => ({ ...current, keys: current.keys.map((item) => item.id === row.id ? { ...item, label: event.currentTarget.value } : item) }))} value={row.label || row.id} />
                  <input aria-label={row.id} disabled={disabled} onChange={(event) => setPool((current) => ({ ...current, keys: current.keys.map((item) => item.id === row.id ? { ...item, key: event.currentTarget.value } : item) }))} placeholder="Paste key, then Save" type="password" value={row.key || ""} />
                  {pool.keys.length > 1 ? <SandButton disabled={disabled || pool.pool.some((slot) => slot.secret === row.id)} onClick={() => setPool((current) => ({ ...current, keys: current.keys.filter((item) => item.id !== row.id) }))} size="sm" variant="secondary">Remove</SandButton> : null}
                </span>
              </label>
            ))}
            <SandButton disabled={disabled || pool.keys.length >= 32} onClick={() => setPool((current) => {
              const id = nextKeyId(current.keys);
              return { ...current, keys: [...current.keys, { id, label: id, key: "" }] };
            })} size="sm" variant="secondary">Add key</SandButton>
          </Group>
          <Group title="Models">
            <div className="sand-settings-field__hint">Saved on the box. Each model picks a key. Chat, compress and fallback pick from this pool.</div>
            {pool.pool.map((slot) => (
              <label key={slot.id}>
                <span>{slot.name || slot.model}<small>{slot.model} · {slot.baseURL}</small></span>
                <span className="sand-router-inline">
                  <SandButton disabled={disabled} onClick={() => setPool((current) => ({ ...current, editing: { ...slot } }))} size="sm" variant="secondary">Edit</SandButton>
                  {pool.pool.length > 1 ? <SandButton disabled={disabled} onClick={() => setPool((current) => {
                    const next = current.pool.filter((item) => item.id !== slot.id);
                    const chatId = current.chatId === slot.id ? next[0]!.id : current.chatId;
                    return { ...current, pool: next, chatId, compactId: current.compactId === slot.id ? "" : current.compactId, imageId: current.imageId === slot.id ? "" : current.imageId, fallbackIds: current.fallbackIds.filter((id) => id !== slot.id), editing: current.editing?.id === slot.id ? null : current.editing };
                  })} size="sm" variant="secondary">Remove</SandButton> : null}
                </span>
              </label>
            ))}
            <SandButton disabled={disabled || pool.pool.length >= 256} onClick={() => setPool((current) => {
              const id = newModelId(current.pool);
              const slot = { ...applyProvider("custom"), id, secret: current.keys[0]?.id || "CUSTOM_API_KEY" };
              return { ...current, pool: [...current.pool, slot], editing: slot };
            })} size="sm" variant="secondary">Add model</SandButton>
            {pool.editing ? (
              <div>
                <label>
                  <span>Name<small>Shown in Chat / Compress / Fallback pickers.</small></span>
                  <input aria-label="Model name" disabled={disabled} onChange={(event) => setPool((current) => current.editing == null ? current : { ...current, editing: { ...current.editing, name: event.currentTarget.value } })} value={pool.editing.name} />
                </label>
                <label>
                  <span>Provider<small>Fills base URL and models. Edit the URL for a relay.</small></span>
                  <SandSelect ariaLabel="API provider" menuSize="md" onValueChange={(value) => {
                    if (value == null) return;
                    setPool((current) => current.editing == null ? current : { ...current, editing: { ...applyProvider(value, catalog().find((item) => item.id === value)?.models[0]?.id), id: current.editing.id, key: current.editing.key, secret: current.editing.secret } });
                  }} options={catalog().map((item) => ({ value: item.id, label: item.label }))} placement="bottom-end" value={pool.editing.provider} />
                </label>
                <label>
                  <span>Base URL<small>OpenAI-compatible /v1 URL. Relays go here.</small></span>
                  <input aria-label="Base URL" disabled={disabled} onChange={(event) => setPool((current) => current.editing == null ? current : { ...current, editing: { ...current.editing, baseURL: event.currentTarget.value } })} value={pool.editing.baseURL} />
                </label>
                <label>
                  <span>Model<small>Current IDs for this provider. You can still type a custom ID.</small></span>
                  <span>
                    <span className="sand-router-inline">
                      {editingProvider.models.map((model) => (
                        <SandButton key={model.id} disabled={disabled} onClick={() => setPool((current) => current.editing == null ? current : { ...current, editing: { ...current.editing, model: model.id, contextWindow: String(model.context), maxOutput: String(model.maxOutput), maxInput: String(Math.max(1024, Math.floor(model.context * 0.75) - model.maxOutput)) } })} size="sm" variant={pool.editing?.model === model.id ? "primary" : "secondary"}>{model.label}</SandButton>
                      ))}
                    </span>
                    <input aria-label="Model ID" disabled={disabled} onChange={(event) => setPool((current) => current.editing == null ? current : { ...current, editing: { ...current.editing, model: event.currentTarget.value } })} value={pool.editing.model} />
                  </span>
                </label>
                <label>
                  <span>Thinking<small>Sent as reasoning_effort. Off omits it.</small></span>
                  <SandSelect ariaLabel="Thinking" menuSize="md" onValueChange={(value) => { if (value != null) setPool((current) => current.editing == null ? current : { ...current, editing: { ...current.editing, effort: value } }); }} options={[{ value: "off", label: "Off" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "xhigh", label: "X-High" }, { value: "max", label: "Max" }]} placement="bottom-end" value={pool.editing.effort} />
                </label>
                <label>
                  <span>Context window<small>Reported to the existing summarizer as this connection's window.</small></span>
                  <input aria-label="Context window" disabled={disabled} onChange={(event) => setPool((current) => current.editing == null ? current : { ...current, editing: { ...current.editing, contextWindow: event.currentTarget.value } })} type="number" value={pool.editing.contextWindow} />
                </label>
                <label>
                  <span>Max input tokens<small>Prompt budget. Leave room for output.</small></span>
                  <input aria-label="Max input tokens" disabled={disabled} onChange={(event) => setPool((current) => current.editing == null ? current : { ...current, editing: { ...current.editing, maxInput: event.currentTarget.value } })} type="number" value={pool.editing.maxInput} />
                </label>
                <label>
                  <span>Max output tokens<small>Completion cap sent as max_tokens.</small></span>
                  <input aria-label="Max output tokens" disabled={disabled} onChange={(event) => setPool((current) => current.editing == null ? current : { ...current, editing: { ...current.editing, maxOutput: event.currentTarget.value } })} type="number" value={pool.editing.maxOutput} />
                </label>
                <label>
                  <span>Key<small>Many models can share this key. Paste values in Keys.</small></span>
                  <SandSelect ariaLabel="Key" menuSize="md" onValueChange={(value) => { if (value != null) setPool((current) => current.editing == null ? current : { ...current, editing: { ...current.editing, secret: value } }); }} options={(pool.keys.length > 0 ? pool.keys : [{ id: pool.editing.secret || "CUSTOM_API_KEY", label: pool.editing.secret || "CUSTOM_API_KEY" }]).map((row) => ({ value: row.id, label: row.label || row.id }))} placement="bottom-end" value={pool.editing.secret || pool.keys[0]?.id} />
                </label>
                <SandButton disabled={disabled} onClick={() => setPool((current) => ({ ...current, editing: null }))} size="sm" variant="secondary">Close editor</SandButton>
              </div>
            ) : null}
          </Group>
          <Group title="Assignments">
            <label>
              <span>Chat<small>The turn uses this pool model.</small></span>
              <SandSelect ariaLabel="Chat model" menuSize="md" onValueChange={(value) => { if (value != null) setPool((current) => ({ ...current, chatId: value, fallbackIds: current.fallbackIds.filter((id) => id !== value) })); }} options={poolOptions} placement="bottom-end" value={pool.chatId || poolOptions[0]?.value} />
            </label>
            <label>
              <span>Compress<small>The existing summarizer uses this pool model.</small></span>
              <SandSelect ariaLabel="Compress model" menuSize="md" onValueChange={(value) => { if (value != null) setPool((current) => ({ ...current, compactId: value })); }} options={compactOptions} placement="bottom-end" value={pool.compactId} />
            </label>
            <label>
              <span>Compress at<small>Starts when used tokens reach this share of the chat window.</small></span>
              <SandSelect ariaLabel="Compress at" menuSize="md" onValueChange={(value) => { if (value != null) setPool((current) => ({ ...current, compactAt: value })); }} options={[{ value: "0.5", label: "50%" }, { value: "0.6", label: "60%" }, { value: "0.7", label: "70%" }, { value: "0.75", label: "75%" }, { value: "0.8", label: "80%" }, { value: "0.9", label: "90%" }]} placement="bottom-end" value={pool.compactAt} />
            </label>
            <label>
              <span>Image<small>Dedicated image model from the pool. The chat LLM is not used.</small></span>
              <SandSelect ariaLabel="Image model" menuSize="md" onValueChange={(value) => { if (value != null) setPool((current) => ({ ...current, imageId: value })); }} options={[{ value: "", label: "Not assigned" }, ...poolOptions]} placement="bottom-end" value={pool.imageId} />
            </label>
            <div className="sand-settings-field__hint">Fallback is tried in this order if chat fails before any tokens. A working model stays until it fails twice in a row.</div>
            {pool.fallbackIds.map((id, index) => (
              <label key={id}>
                <span>Fallback {index + 1}<small>Tried after chat, then the next fallback.</small></span>
                <span className="sand-router-inline">
                  <span>{(pool.pool.find((slot) => slot.id === id) || {}).name || id}</span>
                  <SandButton disabled={disabled || index === 0} onClick={() => setPool((current) => ({ ...current, fallbackIds: current.fallbackIds.map((item, itemIndex) => itemIndex === index - 1 ? id : itemIndex === index ? current.fallbackIds[index - 1]! : item) }))} size="sm" variant="secondary">Up</SandButton>
                  <SandButton disabled={disabled || index === pool.fallbackIds.length - 1} onClick={() => setPool((current) => ({ ...current, fallbackIds: current.fallbackIds.map((item, itemIndex) => itemIndex === index + 1 ? id : itemIndex === index ? current.fallbackIds[index + 1]! : item) }))} size="sm" variant="secondary">Down</SandButton>
                  <SandButton disabled={disabled} onClick={() => setPool((current) => ({ ...current, fallbackIds: current.fallbackIds.filter((item) => item !== id) }))} size="sm" variant="secondary">Remove</SandButton>
                </span>
              </label>
            ))}
            {pool.fallbackIds.length < 8 && unusedFallbacks.length > 0 ? (
              <label>
                <span>Add fallback<small>Add another pool model to the fallback list.</small></span>
                <SandSelect ariaLabel="Add fallback" menuSize="md" onValueChange={(value) => { if (value) setPool((current) => ({ ...current, fallbackIds: [...current.fallbackIds, value] })); }} options={[{ value: "", label: "Choose a model" }, ...unusedFallbacks.map((slot) => ({ value: slot.id, label: slot.name || slot.model }))]} placement="bottom-end" value="" />
              </label>
            ) : null}
          </Group>
          <SandButton disabled={disabled || pool.pool.length === 0 || pool.chatId === "" || pool.pool.some((slot) => slot.baseURL.trim().length === 0 || slot.model.trim().length === 0)} onClick={() => void savePool()} size="sm" variant="primary">{busy ? "Saving…" : "Save"}</SandButton>
        </>
      ) : (
        <Group title="Account">
          <div className="sand-settings-field__hint">{provider === "codex" ? "Uses the private ChatGPT login already stored by Codex on this computer." : provider === "claude-code" ? "Uses Claude Code's existing login on this computer." : "Uses the account already connected to Grok Bot."}</div>
        </Group>
      )}
      {error ? <div className="sand-account__error">{error}</div> : null}
      {notice ? <div className="sand-settings-field__hint">{notice}</div> : null}
      <Group title={`Usage for ${ROUTER_OPTIONS.find((item) => item.value === provider)?.label ?? provider}`}>
        <label><span>Requests</span><span>{formatCount(usage.requests)}</span></label>
        <label><span>Input tokens</span><span>{formatCount(usage.inputTokens)}</span></label>
        <label><span>Output tokens</span><span>{formatCount(usage.outputTokens)}</span></label>
        <label><span>Cache tokens</span><span>{formatCount(usage.cacheReadTokens + usage.cacheWriteTokens)}</span></label>
        <label><span>Last used</span><span>{usage.lastUsedAt ? new Date(usage.lastUsedAt).toLocaleString() : "Not used yet"}</span></label>
      </Group>
    </div>
  );
}

export function isKnownRouterProvider(value: unknown): value is RouterProviderId {
  return isRouterProviderId(value);
}
