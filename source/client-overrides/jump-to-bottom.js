void function __sandJumpToBottom() {
  const THRESHOLD = 80;

  function parsePx(value) {
    if (typeof value !== "string") return 0;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }

  function metricsOf(node) {
    if (node == null) {
      return { scrollTop: 0, clientHeight: 0, scrollHeight: 0 };
    }
    const inner = typeof node.querySelector === "function" ? node.querySelector(".sand-virtual-transcript__inner") : null;
    const innerHeight = inner == null
      ? 0
      : Math.max(inner.scrollHeight || 0, inner.offsetHeight || 0, parsePx(inner.style?.height));
    return {
      scrollTop: node.scrollTop || 0,
      clientHeight: node.clientHeight || 0,
      scrollHeight: Math.max(node.scrollHeight || 0, innerHeight),
    };
  }

  function awayFromBottom(node, threshold) {
    const metrics = node != null && typeof node.querySelector === "function" ? metricsOf(node) : (node ?? { scrollTop: 0, clientHeight: 0, scrollHeight: 0 });
    const height = Math.max(metrics.scrollHeight || 0, metrics.innerHeight || 0);
    return height - (metrics.scrollTop || 0) - (metrics.clientHeight || 0) > (threshold ?? THRESHOLD);
  }

  function pickScroller(transcript, _parent) {
    return transcript ?? null;
  }

  globalThis.__sandJumpLogic = { awayFromBottom, THRESHOLD, pickScroller, metricsOf };

  const doc = globalThis.document;
  if (doc == null) return;
  try {

  const STYLE_ID = "sand-jump-bottom-style";
  const BUTTON_CLASS = "sand-jump-bottom";
  const CSS = `
.${BUTTON_CLASS}{
  position:fixed;
  z-index:400;
  width:40px;
  height:40px;
  margin:0;
  padding:0;
  border:0;
  border-radius:50%;
  background:#111;
  color:#fff;
  box-shadow:0 4px 16px rgba(0,0,0,.18);
  cursor:pointer;
  display:none;
  align-items:center;
  justify-content:center;
  opacity:0;
  transform:translateY(8px) scale(.96);
  transition:opacity .16s ease, transform .16s ease;
  -webkit-tap-highlight-color:transparent;
  pointer-events:auto;
}
.${BUTTON_CLASS}[data-show="1"]{
  display:flex;
  opacity:1;
  transform:none;
}
.${BUTTON_CLASS}:hover{ filter:brightness(1.08); }
.${BUTTON_CLASS}:active{ transform:scale(.96); }
.${BUTTON_CLASS} svg{ width:18px; height:18px; display:block; }
[data-theme="cursor-dark"] .${BUTTON_CLASS},
html.dark .${BUTTON_CLASS}{
  background:#f3f3f3;
  color:#111;
  box-shadow:0 4px 16px rgba(0,0,0,.4);
}
@media (prefers-reduced-motion: reduce){
  .${BUTTON_CLASS}{ transition:none; }
}
`;

  function ensureStyle() {
    if (doc.getElementById(STYLE_ID) != null) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  function findScroller() {
    const transcript = doc.querySelector(".sand-virtual-transcript");
    return pickScroller(transcript);
  }

  function placeButton(button, scroller) {
    if (typeof scroller.getBoundingClientRect !== "function") return;
    const rect = scroller.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) {
      button.removeAttribute("data-show");
      return;
    }
    button.style.left = `${Math.round(rect.right - 58)}px`;
    button.style.top = `${Math.round(rect.bottom - 58)}px`;
    button.style.right = "auto";
    button.style.bottom = "auto";
  }

  function install() {
    ensureStyle();
    const host = doc.body;
    if (host == null) return;
    let button = doc.querySelector(`.${BUTTON_CLASS}`);
    if (!(button instanceof globalThis.HTMLButtonElement)) {
      button = doc.createElement("button");
      button.type = "button";
      button.className = BUTTON_CLASS;
      button.setAttribute("aria-label", "跳到最新");
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.7 9.7a1 1 0 0 1 1.4 0L12 13.58l3.9-3.88a1 1 0 1 1 1.4 1.42l-4.6 4.58a1 1 0 0 1-1.4 0L6.7 11.12a1 1 0 0 1 0-1.42Z"/></svg>';
      button.addEventListener("click", () => {
        const scroller = findScroller();
        if (scroller == null) return;
        const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
        const metrics = metricsOf(scroller);
        if (typeof scroller.scrollTo === "function") {
          scroller.scrollTo({ top: metrics.scrollHeight, behavior: reduce ? "auto" : "smooth" });
        } else {
          scroller.scrollTop = metrics.scrollHeight;
        }
        const pill = doc.querySelector(".sand-new-messages-pill__jump");
        if (pill instanceof globalThis.HTMLElement) pill.click();
      });
      host.appendChild(button);
    }
    const scroller = findScroller();
    if (scroller == null) {
      button.removeAttribute("data-show");
      return;
    }
    placeButton(button, scroller);
    if (awayFromBottom(scroller)) button.setAttribute("data-show", "1");
    else button.removeAttribute("data-show");
  }

  let scheduled = 0;
  function schedule() {
    if (scheduled !== 0) return;
    scheduled = globalThis.requestAnimationFrame(() => {
      scheduled = 0;
      install();
    });
  }

  doc.addEventListener("scroll", schedule, { capture: true, passive: true });
  globalThis.addEventListener("resize", schedule);
  new MutationObserver(schedule).observe(doc.documentElement, { childList: true, subtree: true });
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", schedule);
  else schedule();
  } catch {
    return;
  }
}();
