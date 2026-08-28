import { createSandBrowserUseSubagentConfig } from "./tools/sand-browser-use-subagent.js";
import { createSandComputerUseSubagentConfig } from "./tools/sand-computer-use-subagent.js";

export interface ProductionSubagentConfigArgs {
  readonly isSubagentRunner: boolean;
  readonly remoteBoxHasDesktop: boolean;
  readonly remoteBoxAvailable: boolean;
  readonly browserUseOffered: boolean;
  readonly multitaskEnabled: boolean;
  readonly systemPromptOverridden: boolean;
  readonly extra?: readonly unknown[];
  readonly createExecutor?: () => unknown;
}

function customTypeName(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null || !("subagent_type" in config)) {
    return undefined;
  }
  const subagentType = (config as { readonly subagent_type?: unknown }).subagent_type;
  if (typeof subagentType !== "object" || subagentType === null || !("type" in subagentType)) {
    return undefined;
  }
  const type = (subagentType as { readonly type?: unknown }).type;
  if (typeof type !== "object" || type === null || !("case" in type) || !("value" in type)) {
    return undefined;
  }
  if ((type as { readonly case?: unknown }).case !== "custom") return undefined;
  const value = (type as { readonly value?: unknown }).value;
  if (typeof value !== "object" || value === null || !("name" in value)) return undefined;
  const name = (value as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

export function productionSubagentTypeNames(
  configs: readonly unknown[] | undefined,
): string[] {
  if (configs == null) return [];
  return configs.flatMap((config) => {
    const name = customTypeName(config);
    return name === undefined ? [] : [name];
  });
}

export function buildProductionSubagentConfigs(
  args: ProductionSubagentConfigArgs,
): unknown[] | undefined {
  if (args.isSubagentRunner) return undefined;
  const configs = [...(args.extra ?? [])];
  if (args.remoteBoxHasDesktop && args.remoteBoxAvailable) {
    configs.push(createSandComputerUseSubagentConfig({
      browserUseOffered: args.browserUseOffered,
    }));
    if (args.browserUseOffered) configs.push(createSandBrowserUseSubagentConfig());
  }
  if (!args.systemPromptOverridden && args.multitaskEnabled) {
    const executor = args.createExecutor?.() ?? {
      subagent_type: { type: { case: "custom", value: { name: "executor" } } },
      preserveTaskTool: false,
      subagentSource: "builtin" as const,
    };
    const generalPurposeIndex = configs.findIndex(
      (config) => customTypeName(config) === "generalPurpose",
    );
    if (generalPurposeIndex >= 0) configs.splice(generalPurposeIndex, 1, executor);
    else configs.push(executor);
  }
  return configs.length === 0 ? undefined : configs;
}
