import net from 'node:net';
import { Vita3kError } from './errors.js';

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class BridgeClient {
  private socket: net.Socket | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(private readonly pipeName: string, private readonly token: string) {}

  async connect(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'pipe was not available';
    while (Date.now() < deadline) {
      try {
        await this.connectOnce();
        await this.request('hello', {}, 5_000);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.socket?.destroy();
        this.socket = undefined;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Vita3kError('PIPE_TIMEOUT', `Timed out connecting to Vita3K control pipe: ${lastError}`, true);
  }

  async request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (!this.socket || this.socket.destroyed) throw new Vita3kError('PIPE_DISCONNECTED', 'Vita3K control pipe is disconnected.', true);
    const id = this.nextId++;
    const payload = JSON.stringify({ version: 1, id, token: this.token, method, params }) + '\n';
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Vita3kError('PIPE_TIMEOUT', `Vita3K control request timed out: ${method}`, true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(payload, 'utf8', (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Vita3kError('PIPE_DISCONNECTED', error.message, true));
        }
      });
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.rejectAll(new Vita3kError('PIPE_DISCONNECTED', 'Vita3K control pipe closed.', true));
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\${this.pipeName}` : this.pipeName;
      const socket = net.createConnection(pipePath);
      const onError = (error: Error): void => {
        socket.removeListener('connect', onConnect);
        reject(error);
      };
      const onConnect = (): void => {
        socket.removeListener('error', onError);
        this.socket = socket;
        this.closed = false;
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.onData(chunk));
        socket.on('close', () => {
          if (!this.closed) this.rejectAll(new Vita3kError('PIPE_DISCONNECTED', 'Vita3K control pipe disconnected.', true));
        });
        socket.on('error', () => {});
        resolve();
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 2 * 1024 * 1024) {
      this.close();
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as { id?: number; ok?: boolean; result?: Record<string, unknown>; error?: { code?: string; message?: string; retryable?: boolean } };
        if (typeof message.id !== 'number') continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.result ?? {});
        else pending.reject(new Vita3kError(message.error?.code ?? 'BRIDGE_ERROR', message.error?.message ?? 'Vita3K bridge request failed.', message.error?.retryable ?? false));
      } catch {
        // Ignore malformed lines; the bounded buffer prevents unbounded accumulation.
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
