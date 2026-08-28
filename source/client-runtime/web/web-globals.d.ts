// Minimal ambient surface for the in-page runtime. The source tree is
// typechecked with Node types only, so the browser globals the thin client
// touches are declared here instead of pulling the DOM lib into every
// source file.

interface Window {
  desktop?: unknown;
  sandStageAttachment?: unknown;
  coordinatorPort?: unknown;
  SandNative?: unknown;
}

declare var document: {
  documentElement: { dataset: Record<string, string | undefined> };
  createElement(tag: string): {
    setAttribute(name: string, value: string): void;
    set textContent(value: string);
    rel: string;
    href: string;
  };
  head: { appendChild(node: unknown): void };
};

declare var location: { origin: string };

declare var localStorage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
};

declare var navigator: { userAgent: string };

declare function matchMedia(query: string): { matches: boolean };

declare function alert(message: string): void;
