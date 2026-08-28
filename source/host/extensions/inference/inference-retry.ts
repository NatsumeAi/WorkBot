export function isRetryableInferenceError(error: unknown): boolean {
  const status = typeof error === "object" && error != null ? (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode : undefined;
  if (typeof status === "number") {
    if (status === 401 || status === 403) return false;
    if (status === 402 || status === 404 || status === 408 || status === 409 || status === 425 || status === 429 || status === 529) return true;
    if (status >= 500 && status <= 599) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const blob = `${message} ${typeof error === "object" && error != null ? String((error as { data?: unknown; responseBody?: unknown }).data ?? (error as { responseBody?: unknown }).responseBody ?? "") : ""}`;
  if (/unauthorized|invalid token|invalid api key|forbidden/i.test(blob)) return false;
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|EAI_AGAIN/i.test(blob)) return false;
  return /402|404|408|429|500|502|503|504|529|rate limit|quota|insufficient|too many requests|overloaded|capacity|no available|model not found|not found|temporarily unavailable|try again|unavailable/i.test(blob);
}
