import net from "node:net";
import { DEFAULT_PORT, type RpcRequest, type RpcResponse } from "../shared/protocol";

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * TCP client to the in-game plugin. The plugin listens; we dial in and
 * reconnect on drop. Requests are correlated by id over a newline-delimited
 * JSON stream.
 */
export class RctClient {
  private host: string;
  private port: number;
  private sock: net.Socket | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(port = DEFAULT_PORT, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
  }

  private log(msg: string) {
    // stderr only — stdout is the MCP stdio channel.
    process.stderr.write(`[rct-client] ${msg}\n`);
  }

  private ensureConnected(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = new net.Socket();
      this.sock = sock;
      sock.setNoDelay(true);

      const onError = (err: Error) => {
        this.connecting = null;
        this.connected = false;
        reject(new Error(`cannot reach OpenRCT2 plugin at ${this.host}:${this.port} — is the game running with the rct2-agent plugin loaded? (${err.message})`));
      };

      sock.once("error", onError);

      sock.connect(this.port, this.host, () => {
        sock.removeListener("error", onError);
        this.connected = true;
        this.connecting = null;
        this.log(`connected to ${this.host}:${this.port}`);

        sock.on("data", (chunk) => this.onData(chunk.toString("utf8")));
        sock.on("close", () => this.onClose());
        sock.on("error", (err) => {
          this.log(`socket error: ${err.message}`);
        });

        resolve();
      });
    });

    return this.connecting;
  }

  private onData(text: string) {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let res: RpcResponse;
      try {
        res = JSON.parse(line);
      } catch {
        this.log(`bad JSON from plugin: ${line.slice(0, 120)}`);
        continue;
      }
      const p = this.pending.get(res.id);
      if (!p) continue;
      this.pending.delete(res.id);
      clearTimeout(p.timer);
      if (res.ok) p.resolve(res.result);
      else p.reject(new Error(res.error || "unknown plugin error"));
    }
  }

  private onClose() {
    this.log("connection closed");
    this.connected = false;
    this.sock = null;
    this.buffer = "";
    // Reject everything still in flight; the next call will redial.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("connection to OpenRCT2 plugin closed"));
    }
    this.pending.clear();
  }

  /** Send a request and await its response. */
  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
    await this.ensureConnected();
    const id = this.nextId++;
    const req: RpcRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for '${method}'`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sock!.write(JSON.stringify(req) + "\n");
      } catch (e: any) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`failed to send '${method}': ${e.message}`));
      }
    });
  }
}
