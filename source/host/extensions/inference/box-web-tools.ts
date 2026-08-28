const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 1_000_000;
const MAX_DOCUMENTS = 8;

export type BoxWebSearchArgs = {
  readonly searchTerm?: string;
  readonly searchQuery?: string;
  readonly searchTerm?: string;
  readonly query?: string;
  readonly explanation?: string;
};

export type BoxWebSearchDocument = {
  readonly url: string;
  readonly title: string;
  readonly text: string;
};

export type BoxWebFetchResult =
  | { readonly content: string }
  | { readonly error: string; readonly isTimeout?: boolean };

function queryOf(args: BoxWebSearchArgs): string {
  return (args.searchTerm ?? args.searchQuery ?? args.searchTerm ?? args.query ?? "").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, digits) => String.fromCharCode(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function unwrapDuckDuckGoUrl(raw: string): string {
  try {
    const absolute = new URL(raw, "https://duckduckgo.com");
    const uddg = absolute.searchParams.get("uddg") ?? absolute.searchParams.get("uddg");
    if (uddg != null && uddg.length > 0) return uddg;
    return absolute.href;
  } catch {
    return raw;
  }
}

export function parseDuckDuckGoHtml(html: string): BoxWebSearchDocument[] {
  const documents: BoxWebSearchDocument[] = [];
  const block = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|$)/gi;
  for (const match of html.matchAll(block)) {
    const url = unwrapDuckDuckGoUrl(decodeEntities(match[1] ?? ""));
    const title = stripTags(match[2] ?? "");
    const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(match[3] ?? "");
    const text = stripTags(snippetMatch?.[1] ?? "");
    if (!url.startsWith("http") || title.length === 0) continue;
    documents.push({ url, title, text });
    if (documents.length >= MAX_DOCUMENTS) break;
  }
  return documents;
}

export function parseBingHtml(html: string): BoxWebSearchDocument[] {
  const documents: BoxWebSearchDocument[] = [];
  const block = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  for (const match of html.matchAll(block)) {
    const chunk = match[1] ?? "";
    const link = /<h2[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (link == null) continue;
    const url = decodeEntities(link[1] ?? "");
    const title = stripTags(link[2] ?? "");
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(chunk);
    const text = stripTags(snippet?.[1] ?? "");
    if (!url.startsWith("http") || title.length === 0) continue;
    documents.push({ url, title, text });
    if (documents.length >= MAX_DOCUMENTS) break;
  }
  return documents;
}

export function parseBaiduHtml(html: string): BoxWebSearchDocument[] {
  const documents: BoxWebSearchDocument[] = [];
  const block = /<h3[^>]*class="[^"]*t[^"]*"[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(block)) {
    const url = decodeEntities(match[1] ?? "");
    const title = stripTags(match[2] ?? "");
    if (!url.startsWith("http") || title.length === 0) continue;
    documents.push({ url, title, text: title });
    if (documents.length >= MAX_DOCUMENTS) break;
  }
  return documents;
}

async function fetchHtml(url: string, fetchImpl: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return new TextDecoder("utf-8").decode(buffer.subarray(0, MAX_BYTES));
  } finally {
    clearTimeout(timer);
  }
}

async function searchWith(
  url: string,
  parse: (html: string) => BoxWebSearchDocument[],
  fetchImpl: typeof fetch,
): Promise<BoxWebSearchDocument[]> {
  return parse(await fetchHtml(url, fetchImpl));
}

export async function searchTheWeb(query: string, fetchImpl: typeof fetch = fetch): Promise<BoxWebSearchDocument[]> {
  const encoded = encodeURIComponent(query);
  const engines: readonly (() => Promise<BoxWebSearchDocument[]>)[] = [
    () => searchWith(`https://html.duckduckgo.com/html/?q=${encoded}`, parseDuckDuckGoHtml, fetchImpl),
    () => searchWith(`https://www.bing.com/search?q=${encoded}`, parseBingHtml, fetchImpl),
    () => searchWith(`https://www.baidu.com/s?wd=${encoded}`, parseBaiduHtml, fetchImpl),
  ];
  let lastError: unknown;
  for (const engine of engines) {
    try {
      const documents = await engine();
      if (documents.length > 0) return documents;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError != null) throw lastError;
  return [];
}

export async function fetchAsText(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http and https URLs can be fetched.");
  const html = await fetchHtml(parsed.href, fetchImpl);
  return stripTags(html);
}

export function createBoxWebSearchService(fetchImpl: typeof fetch = fetch) {
  return async (_ctx: unknown, args: BoxWebSearchArgs) => {
    const query = queryOf(args);
    if (query.length === 0) return { documents: [] as const };
    const documents = await searchTheWeb(query, fetchImpl);
    return { documents };
  };
}

export function createBoxWebFetchService(fetchImpl: typeof fetch = fetch) {
  return async (_ctx: unknown, url: string): Promise<BoxWebFetchResult> => {
    try {
      return { content: await fetchAsText(url, fetchImpl) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = error instanceof Error && error.name === "AbortError" || /timeout|abort/i.test(message);
      return { error: message, ...(isTimeout ? { isTimeout: true } : {}) };
    }
  };
}
