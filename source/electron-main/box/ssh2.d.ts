declare module "ssh2" {
  export class Client {
    on(event: "ready", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    connect(config: Record<string, unknown>): this;
    exec(
      command: string,
      options: Record<string, unknown>,
      callback: (error: Error | undefined, stream: unknown) => void,
    ): void;
    sftp(callback: (error: Error | undefined, sftp: unknown) => void): void;
    forwardOut(
      srcIP: string,
      srcPort: number,
      dstIP: string,
      dstPort: number,
      callback: (error: Error | undefined, stream: unknown) => void,
    ): void;
    end(): void;
  }
}
