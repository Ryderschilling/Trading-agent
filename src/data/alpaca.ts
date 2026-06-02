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

// How long before a per-symbol silence triggers a re-subscribe attempt.
// Alpaca sends 1-min bars during RTH — 3 minutes is a conservative threshold
// that catches a partial feed drop (05-20 AMZN/IWM/SPY incident) while
// ignoring brief quiet spells on low-volume stocks.
const SYMBOL_STALE_MS = 3 * 60_000;

export class AlpacaStream {
  private ws: WebSocket | null = null;
  private cfg: AlpacaStreamConfig;
  private subscribedSymbols: Set<string> = new Set();
  private reconnectDelayMs = BACKOFF_MIN_MS;

  // Track when each symbol last delivered a bar so we can detect partial drops.
  private lastBarMs: Map<string, number> = new Map();
  private staleCheckInterval: ReturnType<typeof setInterval> | null = null;

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

    // Per-symbol stale detection — catches partial feed drops where the
    // WebSocket stays open but individual symbols stop delivering bars.
    // Runs every 90s; during market hours only (lastBarMs only updates
    // when bars are actually flowing, so this is naturally quiet pre/post-RTH).
    if (!this.staleCheckInterval) {
      this.staleCheckInterval = setInterval(() => {
        this.resubscribeStaleSymbols();
      }, 90_000);
    }
  }

  subscribeBars(symbols: string[]) {
    for (const s of symbols) this.subscribedSymbols.add(s);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ action: "subscribe", bars: symbols }));
  }

  unsubscribeBars(symbols: string[]) {
    for (const s of symbols) {
      this.subscribedSymbols.delete(s);
      this.lastBarMs.delete(s);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ action: "unsubscribe", bars: symbols }));
  }

  private resubscribeAll() {
    if (this.subscribedSymbols.size === 0) return;
    const symbols = Array.from(this.subscribedSymbols);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ action: "subscribe", bars: symbols }));
  }

  // Re-subscribe any symbol that has been silent longer than SYMBOL_STALE_MS
  // while we expect bars to be flowing (i.e., the symbol has seen at least one
  // bar this session so lastBarMs is set).
  private resubscribeStaleSymbols() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const stale: string[] = [];
    for (const sym of this.subscribedSymbols) {
      const last = this.lastBarMs.get(sym);
      if (last !== undefined && now - last > SYMBOL_STALE_MS) {
        stale.push(sym);
      }
    }
    if (stale.length === 0) return;
    console.warn(
      `[alpaca] partial feed drop detected — re-subscribing ${stale.length} stale symbol(s): ${stale.join(", ")}`
    );
    // Unsubscribe then re-subscribe to force Alpaca to re-attach the feed.
    this.ws.send(JSON.stringify({ action: "unsubscribe", bars: stale }));
    // Small delay so Alpaca processes the unsub before the resub.
    setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ action: "subscribe", bars: stale }));
        // Reset lastBarMs so we don't re-trigger immediately if the first new
        // bar takes a moment to arrive.
        for (const sym of stale) {
          this.lastBarMs.delete(sym);
        }
      }
    }, 500);
  }

  private handleMsg(msg: any) {
    if (msg?.T === "b" && msg?.S) {
      // Update per-symbol last-bar timestamp for stale detection.
      this.lastBarMs.set(msg.S as string, Date.now());
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
