import { createApiGenerateImageService } from "../inference/api-generate-image.js";

export class SandGenerateImagePersistError extends Error {}
export interface GenerateImageAuth { readonly getAccessToken: () => Promise<string>; readonly getMachineId: () => Promise<string> }
export interface GeneratedImage { readonly imageData: string; readonly mimeType: string }
export interface PersistedImage { readonly absolutePath: string }
export function createSandGenerateImageService<Context>(auth: GenerateImageAuth, options: {
  readonly persistImage: (bytes: Uint8Array, mimeType: string) => Promise<PersistedImage | null>;
  readonly onRequestId?: (id: string) => void;
}) {
  const generateImage = createApiGenerateImageService();
  return async (ctx: Context, description: string, _filePath: string, referenceImages: readonly { data: string; mimeType: string }[]) => {
    const generated = await generateImage(ctx, description, referenceImages);
    const persisted = await options.persistImage(Buffer.from(generated.imageData, "base64"), generated.mimeType);
    if (persisted == null) throw new SandGenerateImagePersistError("Failed to save the generated image into the agent's media store.");
    return { filePath: persisted.absolutePath, imageData: generated.imageData };
  };
}
