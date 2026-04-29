import WebSocket from "ws";

export type AlpacaBarMsg = {
  T: "b";
  S: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: string; // ISO timestamp
};

export type AlpacaStreamConfig = {
  key: string;
  secret: string;
  feed: "iex" | "sip" | "delayed_sip";
};

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export class AlpacaStream {
  private ws: WebSocket | null = null;
  private cfg: AlpacaStreamConfig;
  private subscribedSymbols: Set<string> = new Set();
  private reconnectDelayMs = BACKOFF_MIN_MS;

  constructor(
    cfg: AlpacaStreamConfig,
    private handlers: {
      onBar: (b: AlpacaBarMsg) => void;
      onStatus: (s: string) => void;
    }
  ) {
    this.cfg = cfg;
  }

  connect() {
    const url = `wss://stream.data.alpaca.markets/v2/${this.cfg.feed}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.handlers.onStatus("connected");
      this.ws!.send(
        JSON.stringify({
          action: "auth",
          key: this.cfg.key,
          secret: this.cfg.secret
        })
      );
    });

    this.ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const msgs = Array.isArray(data) ? data : [data];
        for (const msg of msgs) this.handleMsg(msg);
      } catch {
        // ignore parse errors
      }
    });

    this.ws.on("close", () => {
      this.handlers.onStatus("disconnected");
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, BACKOFF_MAX_MS);
      setTimeout(() => this.connect(), delay);
    });

    this.ws.on("error", () => {
      // error triggers close → reconnect handled above
    });
  }

  subscribeBars(symbols: string[]) {
    for (const s of symbols) this.subscribedSymbols.add(s);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ action: "subscribe", bars: symbols }));
  }

  unsubscribeBars(symbols: string[]) {
    for (const s of symbols) this.subscribedSymbols.delete(s);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ action: "unsubscribe", bars: symbols }));
  }

  private resubscribeAll() {
    if (this.subscribedSymbols.size === 0) return;
    const symbols = Array.from(this.subscribedSymbols);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ action: "subscribe", bars: symbols }));
  }

  private handleMsg(msg: any) {
    if (msg?.T === "b" && msg?.S) {
      this.handlers.onBar(msg as AlpacaBarMsg);
      return;
    }
    if (msg?.T === "success" && msg?.msg) {
      this.handlers.onStatus(String(msg.msg));
      if (String(msg.msg).toLowerCase() === "authenticated") {
        // Auth succeeded — reset backoff and re-subscribe to tracked symbols
        this.reconnectDelayMs = BACKOFF_MIN_MS;
        this.resubscribeAll();
      }
      return;
    }
    if (msg?.T === "error" && msg?.msg) {
      this.handlers.onStatus(`error: ${msg.msg}`);
      return;
    }
  }
}
