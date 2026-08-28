import type http from "node:http";
import type net from "node:net";
import type tls from "node:tls";

export const SAND_OUTBOUND_PROXY_MODES = ["off", "custom"] as const;
export type SandOutboundProxyMode = (typeof SAND_OUTBOUND_PROXY_MODES)[number];

export type OutboundProxyResolution =
  | { readonly kind: "direct" }
  | {
    readonly kind: "proxy";
    readonly httpProxy: string;
    readonly httpsProxy: string;
  };

export function isSandOutboundProxyMode(value: unknown): value is SandOutboundProxyMode {
  return value === "off" || value === "custom";
}

export function isHttpProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function hostnameIsLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return host === "127.0.0.1" || host.startsWith("127.");
}

export function resolveOutboundProxy(input: {
  readonly mode?: unknown;
  readonly customUrl?: unknown;
}): OutboundProxyResolution {
  const mode = isSandOutboundProxyMode(input.mode) ? input.mode : "off";
  if (mode !== "custom") return { kind: "direct" };
  const custom = typeof input.customUrl === "string" ? input.customUrl.trim() : "";
  if (!isHttpProxyUrl(custom)) return { kind: "direct" };
  return { kind: "proxy", httpProxy: custom, httpsProxy: custom };
}

function headerObject(request: Request): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  request.headers.forEach((value, name) => {
    if (name.toLowerCase() === "host") return;
    headers[name] = value;
  });
  return headers;
}

function proxyAuthorization(proxyUrl: string): string | undefined {
  const url = new URL(proxyUrl);
  if (url.username === "" && url.password === "") return undefined;
  return `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
}

function collectResponse(incoming: http.IncomingMessage): Promise<Response> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    incoming.on("error", reject);
    incoming.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value == null) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 502, headers }));
    });
  });
}

function writeRequestBody(req: http.ClientRequest, request: Request): void {
  void request.arrayBuffer().then((body) => {
    if (body.byteLength > 0) req.write(Buffer.from(body));
    req.end();
  }, (error) => {
    req.destroy(error);
  });
}

async function fetchHttpViaProxy(proxyUrl: string, request: Request): Promise<Response> {
  const http = (await import("node:http")).default;
  const proxy = new URL(proxyUrl);
  const target = new URL(request.url);
  const headers = headerObject(request);
  headers.host = target.host;
  const authorization = proxyAuthorization(proxyUrl);
  if (authorization != null) headers["proxy-authorization"] = authorization;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
      method: request.method,
      path: request.url,
      headers,
    }, (incoming) => {
      void collectResponse(incoming).then(resolve, reject);
    });
    req.on("error", reject);
    writeRequestBody(req, request);
  });
}

async function fetchHttpsViaProxy(proxyUrl: string, request: Request): Promise<Response> {
  const [http, net, tls] = await Promise.all([
    import("node:http").then(module => module.default),
    import("node:net").then(module => module.default),
    import("node:tls").then(module => module.default),
  ]);
  const proxy = new URL(proxyUrl);
  const target = new URL(request.url);
  const port = target.port || "443";
  const headers: http.OutgoingHttpHeaders = { host: `${target.hostname}:${port}` };
  const authorization = proxyAuthorization(proxyUrl);
  if (authorization != null) headers["proxy-authorization"] = authorization;
  return new Promise((resolve, reject) => {
    const connect = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers,
    });
    connect.on("connect", (incoming, socket) => {
      if (incoming.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed (${incoming.statusCode ?? 0}).`));
        return;
      }
      const tlsOptions: tls.ConnectionOptions = { socket };
      if (net.isIP(target.hostname) === 0) tlsOptions.servername = target.hostname;
      const tlsSocket = tls.connect(tlsOptions, () => {
        const inner = http.request({
          hostname: target.hostname,
          port: Number(port),
          path: `${target.pathname}${target.search}`,
          method: request.method,
          headers: { ...headerObject(request), host: target.host },
          createConnection: () => tlsSocket,
        }, (response) => {
          void collectResponse(response).then(resolve, reject);
        });
        inner.on("error", reject);
        writeRequestBody(inner, request);
      });
      tlsSocket.on("error", reject);
    });
    connect.on("error", reject);
    connect.end();
  });
}

export function createOutboundFetch(
  resolved: OutboundProxyResolution,
  baseline: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  if (resolved.kind === "direct") return baseline;
  return async (input, init) => {
    const request = input instanceof Request && init == null ? input : new Request(input, init);
    const url = new URL(request.url);
    if (hostnameIsLoopback(url.hostname)) return baseline(request);
    const proxyUrl = url.protocol === "https:" ? resolved.httpsProxy : resolved.httpProxy;
    return url.protocol === "https:" ? await fetchHttpsViaProxy(proxyUrl, request) : await fetchHttpViaProxy(proxyUrl, request);
  };
}

let installedBaseline: typeof fetch | null = null;
let applied: OutboundProxyResolution = { kind: "direct" };

export function curlProxyUrl(target?: string): string | undefined {
  if (applied.kind !== "proxy") return undefined;
  if (target == null || target.trim().length === 0) return undefined;
  try {
    if (hostnameIsLoopback(new URL(target).hostname)) return undefined;
  } catch {
    return undefined;
  }
  return applied.httpProxy;
}

export function applyOutboundProxyToGlobalFetch(resolved: OutboundProxyResolution): void {
  applied = resolved;
  if (installedBaseline == null) installedBaseline = globalThis.fetch.bind(globalThis);
  globalThis.fetch = createOutboundFetch(resolved, installedBaseline);
}

export function applyOutboundProxyFromSettings(settings: {
  readonly outboundProxyMode?: unknown;
  readonly outboundProxyUrl?: unknown;
}): OutboundProxyResolution {
  const resolved = resolveOutboundProxy({
    mode: settings.outboundProxyMode,
    customUrl: settings.outboundProxyUrl,
  });
  applyOutboundProxyToGlobalFetch(resolved);
  return resolved;
}
