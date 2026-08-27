import { MAIN_METHOD_TABLE, type MainMethod } from "./rpc/main.js";
import { COORDINATOR_METHOD_TABLE, type CoordinatorMethod } from "./rpc/coordinator.js";
import type { SandCapability } from "./capabilities.js";

const MAIN_CAPABILITY: Partial<Record<MainMethod, SandCapability>> = {
  getCursorAuthStatus: "auth",
  loginCursor: "auth",
  cancelCursorLogin: "auth",
  logoutCursor: "auth",
  updateCursorAccountName: "auth",
  getCursorAvatar: "auth",
  getCursorWeeklyUsage: "auth",
  getCursorUsageSummary: "auth",
  getCursorPrReviewPreferences: "auth",
  getCursorPrivacyModeEnabled: "auth",
  getSandAccess: "auth",
  getSandAccessFresh: "auth",
  invokeCursorDashboardAction: "auth",
  cancelCursorSandTrial: "auth",
  getInferenceRouter: "inferenceRouter",
  setInferenceRouter: "inferenceRouter",
  setInferenceEndpoints: "inferenceRouter",
  listSecrets: "secrets",
  revealSecret: "secrets",
  upsertSecrets: "secrets",
  removeSecrets: "secrets",
  getMcpState: "mcp",
  getEffectivePlugins: "mcp",
  getMcpCatalog: "mcp",
  getMcpTeamPopularity: "mcp",
  getMcpPluginLogo: "mcp",
  installEntry: "mcp",
  updatePluginInstall: "mcp",
  removeMcpServer: "mcp",
  uninstallPlugin: "mcp",
  authenticateMcpServer: "mcp",
  renameMcpAccount: "mcp",
  removeMcpAccount: "mcp",
  setMcpCustomInstructions: "mcp",
  listMcpServerTools: "mcp",
  toggleMcpToolDisabled: "mcp",
  forceReconnectGateway: "remoteBox",
  getBoxMigrationStatus: "remoteBox",
  updateComputer: "remoteBox",
  forceRecreateComputer: "remoteBox",
  getBoxRuntime: "localDockerVm",
  setBoxRuntime: "localDockerVm",
  getSelfHostConnection: "remoteBox",
  setSelfHostConnection: "remoteBox",
  getSelfHostInstallCommand: "remoteBox",
  installSelfHostBox: "remoteBox",
  testSelfHostGateway: "remoteBox",
  pickSelfHostKeyFile: "remoteBox",
  openSelfHostDocs: "remoteBox",
  getWindowState: "windowChrome",
  minimizeWindow: "windowChrome",
  toggleMaximizeWindow: "windowChrome",
  closeWindow: "windowChrome",
  resizeWindowWidth: "windowChrome",
  setTitleBarOverlayTone: "windowChrome",
  getWebauthnProxyEnabled: "webauthnSigner",
  setWebauthnProxyEnabled: "webauthnSigner",
  reportVncSession: "vncComputer",
  reportVncLiveness: "vncComputer",
  reportOpenComputer: "vncComputer",
};

const COORDINATOR_CAPABILITY: Partial<Record<CoordinatorMethod, SandCapability>> = {
  getForeverBoxStatus: "vncComputer",
  ensureForeverBox: "vncComputer",
  handBackForeverBox: "vncComputer",
  startTeachRecording: "vncComputer",
  stopTeachRecording: "vncComputer",
  getTeachRecordingStatus: "vncComputer",
  listRoutedMcpTools: "mcp",
  executeRoutedMcpTool: "mcp",
  skillsCatalog: "mcp",
  syncPluginSkills: "mcp",
  getPluginSyncStatus: "mcp",
  getSkillPublishTargets: "mcp",
  publishSkill: "mcp",
  resyncPublishedSkill: "mcp",
  unpublishSkill: "mcp",
};

export function capabilityForMainMethod(method: string): SandCapability | null {
  if (!Object.hasOwn(MAIN_METHOD_TABLE, method)) return null;
  return MAIN_CAPABILITY[method as MainMethod] ?? null;
}

export function capabilityForCoordinatorMethod(method: string): SandCapability | null {
  if (!Object.hasOwn(COORDINATOR_METHOD_TABLE, method)) return null;
  return COORDINATOR_CAPABILITY[method as CoordinatorMethod] ?? "conversation";
}
