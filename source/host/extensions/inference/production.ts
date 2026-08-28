import type { HostExtensionContext } from "../../../internal/host-extensions.js";
import type { SandAgentModelSelection } from "../../../shared/agents/sand-agent-model.js";
import { createBoxWebFetchService, createBoxWebSearchService } from "./box-web-tools.js";
import { createHostInference } from "./inference-service.js";
import type { InferenceExtensionContext } from "./extension.js";

type ProductionContext = HostExtensionContext<unknown> & {
  readonly deps: InferenceExtensionContext["deps"];
};

/** Recreates the artifact's concrete inference construction at host-main.cjs:617672-617732. */
export function createInferenceProductionExtras(
  context: ProductionContext,
): Omit<InferenceExtensionContext, "deps"> {
  const auth = context.deps.auth;
  return {
    createPort(onModelExperimentApplied) {
      return createHostInference({
        auth,
        experiments: context.deps.experiments,
        settings: context.deps.settings,
        onModelExperimentApplied,
      });
    },
    createWebSearch(_args) {
      return createBoxWebSearchService();
    },
    createWebFetch(_args) {
      return createBoxWebFetchService();
    },
  };
}

export type InferenceModelSelection = SandAgentModelSelection;
