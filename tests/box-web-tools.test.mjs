import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: ["source/host/extensions/inference/box-web-tools.ts"],
    format: "esm",
    platform: "node",
    write: false,
    packages: "external",
  });
  const file = result.outputFiles[0];
  if (file == null) throw new Error("esbuild produced no output");
  return import(`data:text/javascript;base64,${Buffer.from(file.text).toString("base64")}`);
}

test("DuckDuckGo and Bing HTML parsers keep titles, urls, and snippets", async () => {
  const { parseDuckDuckGoHtml, parseBingHtml } = await load();
  const duck = parseDuckDuckGoHtml(`
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews">Example News</a>
    <a class="result__snippet" href="https://example.com/news">A snippet about the story.</a>
    <a class="result__a" href="https://example.org">Second</a>
  `);
  assert.equal(duck[0]?.url, "https://example.com/news");
  assert.equal(duck[0]?.title, "Example News");
  assert.match(duck[0]?.text ?? "", /snippet/);
  const bing = parseBingHtml(`
    <li class="b_algo"><h2><a href="https://example.net/a">Bing Title</a></h2><p>Bing snippet here.</p></li>
  `);
  assert.equal(bing[0]?.url, "https://example.net/a");
  assert.equal(bing[0]?.title, "Bing Title");
  assert.match(bing[0]?.text ?? "", /Bing snippet/);
});

test("box web fetch rejects non-http URLs and returns page text", async () => {
  const { createBoxWebFetchService } = await load();
  const fetchImpl = async (url) => {
    assert.equal(String(url), "https://example.com/page");
    return new Response("<html><script>x</script><p>Hello world</p></html>", { status: 200 });
  };
  const fetchPage = createBoxWebFetchService(fetchImpl);
  const blocked = await fetchPage({}, "file:///etc/passwd");
  assert.equal("error" in blocked, true);
  const page = await fetchPage({}, "https://example.com/page");
  assert.equal("content" in page, true);
  if ("content" in page) assert.match(page.content, /Hello world/);
});

test("box web search uses the first engine that returns documents", async () => {
  const { createBoxWebSearchService } = await load();
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("duckduckgo")) return new Response("nope", { status: 503 });
    if (href.includes("bing")) {
      return new Response(`<li class="b_algo"><h2><a href="https://example.com/hit">Hit</a></h2><p>ok</p></li>`, { status: 200 });
    }
    throw new Error("unexpected engine");
  };
  const search = createBoxWebSearchService(fetchImpl);
  const official = await search({}, { searchTerm: "openbot" });
  assert.equal(official.documents[0]?.url, "https://example.com/hit");
});

test("box web search throws when every engine fails", async () => {
  const { createBoxWebSearchService } = await load();
  const search = createBoxWebSearchService(async () => {
    throw new Error("engine down");
  });
  await assert.rejects(() => search({}, { searchTerm: "openbot" }), /engine down/);
});

test("inference extras bind box web tools instead of Cursor RPCs", async () => {
  const production = await readFile(path.join(repoRoot, "source/host/extensions/inference/production.ts"), "utf8");
  assert.match(production, /createBoxWebSearchService/);
  assert.match(production, /createBoxWebFetchService/);
  assert.doesNotMatch(production, /createCursorWebSearchService/);
  assert.doesNotMatch(production, /createCursorWebFetchService/);
});
