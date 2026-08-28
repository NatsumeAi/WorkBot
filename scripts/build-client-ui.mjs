import { aggregateInventorySha256, buildClientUi, clientUiManifestPath, clientUiRoot } from "./lib/four-pack.mjs";

const built = await buildClientUi();
console.log(`Client UI directory: ${clientUiRoot} (${built.cached ? "reused" : "rebuilt"})`);
console.log(`Client UI manifest: ${clientUiManifestPath}`);
console.log(`Files: ${built.manifest.files.length}, aggregate inventory sha256: ${aggregateInventorySha256(built.manifest)}`);
