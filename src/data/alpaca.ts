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

export class AlpacaStream {
  private ws: WebSocket | null = null;
  private cfg: AlpacaStreamConfig;

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
        // ignore
      }
    });

    this.ws.on("close", () => {
      this.handlers.onStatus("disconnected");
      setTimeout(() => this.connect(), 2000);
    });

    this.ws.on("error", () => {
      // triggers close -> reconnect
    });
  }

  subscribeBars(symbols: string[]) {
    if (!this.ws) return;
    this.ws.send(JSON.stringify({ action: "subscribe", bars: symbols }));
  }

  unsubscribeBars(symbols: string[]) {
    if (!this.ws) return;
    this.ws.send(JSON.stringify({ action: "unsubscribe", bars: symbols }));
  }

  private handleMsg(msg: any) {
    if (msg?.T === "b" && msg?.S) {
      this.handlers.onBar(msg as AlpacaBarMsg);
      return;
    }
    if (msg?.T === "success" && msg?.msg) {
      this.handlers.onStatus(String(msg.msg));
      return;
    }
    if (msg?.T === "error" && msg?.msg) {
      this.handlers.onStatus(`error: ${msg.msg}`);
      return;
    }
  }
}
