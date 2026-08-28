export interface RouterPoolSlot {
  id: string;
  name: string;
  provider: string;
  baseURL: string;
  secret: string;
  model: string;
  effort: string;
  contextWindow: string;
  maxInput: string;
  maxOutput: string;
  key: string;
}

export interface RouterPoolKeyRow {
  id: string;
  label: string;
  key: string;
}

export interface RouterPoolState {
  pool: RouterPoolSlot[];
  keys: RouterPoolKeyRow[];
  chatId: string;
  compactId: string;
  imageId: string;
  fallbackIds: string[];
  compactAt: string;
  editing: RouterPoolSlot | null;
}

export function nextKeyId(existing: readonly { id?: string }[]): string {
  const taken = new Set((Array.isArray(existing) ? existing : []).map((item) => item?.id).filter(Boolean) as string[]);
  let n = 1;
  while (taken.has(`KEY_${n}`)) n += 1;
  return `KEY_${n}`;
}

export function prepareRouterPoolSave(state: RouterPoolState):
  | { ok: false; message: string }
  | { ok: true; pool: RouterPoolSlot[]; keys: RouterPoolKeyRow[]; secrets: Record<string, string>; document: Record<string, unknown> } {
  const poolIn = Array.isArray(state?.pool) ? state.pool : [];
  const editing = state?.editing;
  const pool = editing == null
    ? poolIn
    : poolIn.some((item) => item.id === editing.id)
      ? poolIn.map((item) => item.id === editing.id ? editing : item)
      : [...poolIn, editing];
  if (pool.length === 0) return { ok: false, message: "Add a model first." };
  const chat = pool.find((item) => item.id === state.chatId) ?? pool[0]!;
  const keyRowsIn = Array.isArray(state?.keys) ? state.keys : [];
  const keyRows: RouterPoolKeyRow[] = [];
  const seenKeys = new Set<string>();
  const pushKey = (id: unknown, label: unknown) => {
    const name = typeof id === "string" ? id.trim() : "";
    if (name.length === 0 || seenKeys.has(name)) return;
    seenKeys.add(name);
    const row = keyRowsIn.find((item) => item?.id === name);
    keyRows.push({
      id: name,
      label: (typeof label === "string" && label.trim().length > 0 ? label.trim() : (typeof row?.label === "string" && row.label.trim().length > 0 ? row.label.trim() : name)),
      key: typeof row?.key === "string" ? row.key : "",
    });
  };
  for (const row of keyRowsIn) pushKey(row?.id, row?.label);
  for (const slot of pool) pushKey(slot?.secret, slot?.secret);
  if (keyRows.length === 0) pushKey("CUSTOM_API_KEY", "Custom");
  const secrets: Record<string, string> = {};
  for (const row of keyRows) {
    const value = typeof row.key === "string" ? row.key.trim() : "";
    if (value.length > 0) secrets[row.id] = value;
  }
  for (const slot of pool) {
    const value = typeof slot.key === "string" ? slot.key.trim() : "";
    const name = typeof slot.secret === "string" ? slot.secret.trim() : "";
    if (value.length > 0 && name.length > 0) secrets[name] = value;
  }
  const taken = new Set(pool.map((item) => item.id).filter(Boolean));
  let nextId = 1;
  const alloc = () => {
    while (taken.has(`model-${nextId}`)) nextId += 1;
    const id = `model-${nextId}`;
    taken.add(id);
    nextId += 1;
    return id;
  };
  const fallbackSecret = keyRows[0]?.id ?? "CUSTOM_API_KEY";
  const endpoints = pool.map((slot) => {
    const id = typeof slot.id === "string" && slot.id.length > 0 ? slot.id : alloc();
    const apiKeySecret = typeof slot.secret === "string" && slot.secret.trim().length > 0 ? slot.secret.trim() : fallbackSecret;
    const payload: Record<string, unknown> = {
      id,
      label: String(slot.name ?? slot.model ?? "").trim(),
      kind: "openai-compatible",
      baseURL: String(slot.baseURL ?? "").trim(),
      apiKeySecret,
      model: String(slot.model ?? "").trim(),
      reasoningEffort: slot.effort,
      contextWindow: Number(slot.contextWindow),
      maxInputTokens: Number(slot.maxInput),
      maxOutputTokens: Number(slot.maxOutput),
    };
    if (id === chat.id) payload.compactAt = Number(state.compactAt);
    return payload;
  });
  const compactId = typeof state.compactId === "string" && state.compactId.length > 0 ? state.compactId : chat.id;
  const fallbackIds = Array.isArray(state.fallbackIds)
    ? state.fallbackIds.filter((id) => pool.some((slot) => slot.id === id) && id !== chat.id)
    : [];
  const imageId = typeof state.imageId === "string" && state.imageId.length > 0 ? state.imageId : "";
  const roles = {
    chat: chat.id,
    compact: compactId,
    ...imageId.length > 0 ? { image: imageId } : {},
    ...fallbackIds.length > 0 ? { fallback: fallbackIds[0], fallbacks: fallbackIds } : {},
  };
  return {
    ok: true,
    pool,
    keys: keyRows,
    secrets,
    document: {
      schemaVersion: 1,
      active: chat.id,
      keys: keyRows.map((row) => ({ id: row.id, label: row.label })),
      roles,
      endpoints,
    },
  };
}
