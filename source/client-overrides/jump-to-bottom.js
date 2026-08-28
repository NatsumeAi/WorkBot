void function __sandJumpToBottom() {
  const THRESHOLD = 80;
  function awayFromBottom(node, threshold) {
    if (node == null) return false;
    return node.scrollHeight - node.scrollTop - node.clientHeight > (threshold ?? THRESHOLD);
  }
  globalThis.__sandJumpLogic = { awayFromBottom, THRESHOLD };
  const doc = globalThis.document;
  if (doc == null) return;

  const STYLE_ID = "sand-jump-bottom-style";
  const BUTTON_CLASS = "sand-jump-bottom";
  const CSS = `
.${BUTTON_CLASS}{
  position:absolute;
  right:18px;
  z-index:40;
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

  function overflowParent(start) {
    let node = start;
    while (node != null && node !== doc.body) {
      const style = globalThis.getComputedStyle?.(node);
      const overflowY = style?.overflowY ?? "";
      if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && node.scrollHeight > node.clientHeight + 4) {
        return node;
      }
      node = node.parentElement;
    }
    return start;
  }

  function findScroller() {
    const transcript = doc.querySelector(".sand-virtual-transcript");
    if (transcript == null) return null;
    return overflowParent(transcript);
  }

  function findStage() {
    return doc.querySelector(".sand-chat-stage");
  }

  function dockOffset() {
    const dock = doc.querySelector(".sand-chat-input-dock");
    return dock instanceof globalThis.HTMLElement ? dock.offsetHeight + 12 : 88;
  }

  function install() {
    ensureStyle();
    const stage = findStage();
    if (stage == null) return;
    const style = globalThis.getComputedStyle?.(stage);
    if (style != null && style.position === "static") stage.style.position = "relative";
    let button = stage.querySelector(`.${BUTTON_CLASS}`);
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
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduce ? "auto" : "smooth" });
      });
      stage.appendChild(button);
    }
    const scroller = findScroller();
    if (scroller == null) {
      button.removeAttribute("data-show");
      return;
    }
    button.style.bottom = `${dockOffset()}px`;
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
}();
