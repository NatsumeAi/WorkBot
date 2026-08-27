export interface CursorAccountStatus {
  readonly kind: string;
  readonly authId?: string;
  readonly email?: string;
  readonly [key: string]: unknown;
}

/** Local identity when Cursor is not signed in. Coordinator still starts. */
export const LOCAL_UNSIGNED_ACCOUNT_SLOT = "local";

export function cursorAccountSlot(status: CursorAccountStatus): string {
  if (status.kind === "logged-in") {
    const slot = status.authId ?? status.email;
    if (slot != null && slot.length > 0) return slot;
  }
  return LOCAL_UNSIGNED_ACCOUNT_SLOT;
}
