void function __sandRewindFromHere() {
  const COPY = "从这里重来";
  const NOTICE = "对话从这里重来。不会撤销已经做过的 Shell / 文件 / 浏览器操作。";
  const MENU_LABEL = "Message actions";
  const ITEM_ATTR = "data-sand-rewind";
  const ROW_SELECTOR = "[data-entry-id], [data-row-key]";

  function entryIdFromRow(row) {
    if (row == null || typeof row.getAttribute !== "function") return "";
    const id = row.getAttribute("data-entry-id") ?? row.getAttribute("data-row-key");
    return typeof id === "string" ? id : "";
  }

  function shouldShowRewind(role, entryId) {
    return role === "user" && typeof entryId === "string" && entryId.length > 0;
  }

  function isUserRow(node) {
    if (node == null || typeof node.getAttribute !== "function") return false;
    return shouldShowRewind(node.getAttribute("data-role"), entryIdFromRow(node));
  }

  function isRewindMenu(menu) {
    return menu != null && typeof menu.getAttribute === "function" && menu.getAttribute("aria-label") === MENU_LABEL;
  }

  function rowFromTarget(target) {
    if (target == null || typeof target.closest !== "function") return null;
    const anchor = target.closest(".sand-message-action-anchor") ?? target;
    if (anchor == null || typeof anchor.closest !== "function") return null;
    return anchor.closest(ROW_SELECTOR);
  }

  globalThis.__sandRewindLogic = {
    COPY,
    NOTICE,
    isUserRow,
    shouldShowRewind,
    isRewindMenu,
    rowFromTarget,
    entryIdFromRow,
    menuHasRewind(menu) {
      return menu != null && typeof menu.querySelector === "function" && menu.querySelector(`[${ITEM_ATTR}]`) != null;
    },
  };

  const doc = globalThis.document;
  if (doc == null) return;

  let activeAgentId = null;
  let lastRow = null;
  let nextRequestId = 0;
  const pending = new Map();
  let port = null;

  function rememberAgentId(value) {
    if (typeof value === "string" && value.length > 0) activeAgentId = value;
  }

  function onPortMessage(event) {
    const data = event?.data;
    if (data == null || typeof data !== "object") return;
    if (data.kind === "reply" && typeof data.requestId === "string") {
      const waiter = pending.get(data.requestId);
      if (waiter == null) return;
      pending.delete(data.requestId);
      if (data.outcome?.status === "ok") waiter.resolve(data.outcome.value);
      else waiter.reject(new Error(data.outcome?.failure?.message ?? "rewind failed"));
      return;
    }
    if (data.kind === "event") {
      const payload = data.payload;
      if (payload == null || typeof payload !== "object") return;
      rememberAgentId(payload.activeAgentId);
      rememberAgentId(payload.agentId);
    }
  }

  function capturePort(next) {
    if (next == null || next === port) return;
    port = next;
    if (typeof port.addEventListener === "function") {
      port.addEventListener("message", onPortMessage);
    }
  }

  function hookCoordinatorClaim() {
    const bridge = globalThis.coordinatorPort;
    if (bridge == null || typeof bridge.claim !== "function" || bridge.__sandRewindHooked === true) return;
    const original = bridge.claim.bind(bridge);
    bridge.claim = function (consumer) {
      return original({
        onPort(next) {
          capturePort(next);
          consumer.onPort(next);
        },
      });
    };
    bridge.__sandRewindHooked = true;
  }

  function rewindTranscript(agentId, entryId) {
    if (port == null || typeof port.postMessage !== "function") {
      return Promise.reject(new Error("coordinator port is not ready"));
    }
    nextRequestId += 1;
    const requestId = `sand-rewind-${nextRequestId}`;
    const result = new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
    });
    port.postMessage({
      kind: "request",
      requestId,
      method: "rewindTranscript",
      args: { agentId, entryId },
    });
    return result;
  }

  function rememberRow(event) {
    const row = rowFromTarget(event?.target);
    if (row != null) lastRow = row;
  }

  function injectItem(menu) {
    if (!isRewindMenu(menu)) return;
    if (menu.querySelector(`[${ITEM_ATTR}]`) != null) return;
    const row = lastRow;
    const entryId = entryIdFromRow(row);
    const role = row?.getAttribute("data-role");
    if (!shouldShowRewind(role, entryId)) return;
    const sample = menu.querySelector('[role="menuitem"]');
    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute(ITEM_ATTR, "1");
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-label", COPY);
    button.textContent = COPY;
    if (sample != null && typeof sample.className === "string" && sample.className.length > 0) {
      button.className = sample.className;
    } else {
      button.style.cssText = "display:block;width:100%;margin:0;padding:8px 12px;border:0;background:transparent;text-align:left;font:inherit;cursor:pointer;color:inherit;";
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (globalThis.confirm(NOTICE) !== true) return;
      const agentId = activeAgentId;
      if (typeof agentId !== "string" || agentId.length === 0) return;
      void rewindTranscript(agentId, entryId).catch(() => {});
    });
    menu.appendChild(button);
  }

  hookCoordinatorClaim();
  doc.addEventListener("contextmenu", rememberRow, true);
  const observer = new globalThis.MutationObserver(() => {
    hookCoordinatorClaim();
    for (const menu of doc.querySelectorAll(`[aria-label="${MENU_LABEL}"]`)) injectItem(menu);
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
}();
