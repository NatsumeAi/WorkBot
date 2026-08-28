import type { LocalInferenceCliStatus } from "../../../shared/node/inference-router-local.js";

const unavailable: LocalInferenceCliStatus = { installed: false, authenticated: false, executablePath: null };

/** Browser stub: local inference CLIs only exist on the desktop. */
export function getLocalInferenceCliStatus(): { readonly codex: LocalInferenceCliStatus; readonly "claude-code": LocalInferenceCliStatus } {
  return { codex: unavailable, "claude-code": unavailable };
}
