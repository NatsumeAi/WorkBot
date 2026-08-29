import { randomUUID } from "node:crypto";

import { triggerCronSchedules, triggerListeners, type AutomationTrigger } from "../../../shared/automations.js";
import { automationAnchor, computeNextRunAt } from "../../../shared/automation-schedule.js";

export const LOCAL_CRON_TICK_MS = 5_000;

export interface LocalCronAutomation {
  readonly id: string;
  readonly isEnabled: boolean;
  readonly trigger: AutomationTrigger;
  readonly createdAt?: number;
  readonly nextRunAt?: number | null;
  readonly lastRunAt?: number | null;
  readonly runs?: readonly { readonly id: string; readonly status: string }[];
}

export function nextLocalCronAt(automation: LocalCronAutomation, timeZone?: string): number | null {
  if (typeof automation.nextRunAt === "number" && Number.isFinite(automation.nextRunAt)) return automation.nextRunAt;
  const anchor = automationAnchor({ createdAt: automation.createdAt ?? 0, lastRunAt: automation.lastRunAt ?? null });
  let earliest: number | null = null;
  for (const schedule of triggerCronSchedules(automation.trigger)) {
    const next = computeNextRunAt(schedule, anchor, timeZone);
    if (next != null && (earliest == null || next < earliest)) earliest = next;
  }
  return earliest;
}

export function isDueLocalCron(automation: LocalCronAutomation, now = Date.now(), timeZone?: string): boolean {
  if (!automation.isEnabled) return false;
  if (triggerCronSchedules(automation.trigger).length === 0) return false;
  if (triggerListeners(automation.trigger).length > 0) return false;
  if (automation.runs?.some((run) => run.status === "running")) return false;
  const dueAt = nextLocalCronAt(automation, timeZone);
  return dueAt != null && dueAt <= now;
}

export class LocalCronScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = true;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly deps: {
      readonly isLocalClock: () => boolean;
      readonly isReady: () => boolean | Promise<boolean>;
      readonly listAutomations: () => Promise<readonly { agentId: string; automation: LocalCronAutomation }[]>;
      readonly fire: (args: {
        agentId: string;
        automation: LocalCronAutomation;
        runUuid: string;
        scheduledForMs: number;
      }) => Promise<unknown>;
      readonly getTimeZone?: () => string | undefined;
      readonly now?: () => number;
      readonly intervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.intervalMs ?? LOCAL_CRON_TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking || !this.deps.isLocalClock()) return;
    this.ticking = true;
    try {
      if (!await this.deps.isReady()) return;
      const listed = await this.deps.listAutomations();
      const now = (this.deps.now ?? Date.now)();
      const timeZone = this.deps.getTimeZone?.();
      for (const { agentId, automation } of listed) {
        if (!isDueLocalCron(automation, now, timeZone)) continue;
        const key = `${agentId}:${automation.id}`;
        if (this.inFlight.has(key)) continue;
        this.inFlight.add(key);
        try {
          await this.deps.fire({
            agentId,
            automation,
            runUuid: randomUUID(),
            scheduledForMs: nextLocalCronAt(automation, timeZone) ?? now,
          });
        } finally {
          this.inFlight.delete(key);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
