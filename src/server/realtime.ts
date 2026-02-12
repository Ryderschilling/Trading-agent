import { Server as HttpServer } from "http";
import { Server as IOServer } from "socket.io";
import { Alert } from "../engine/types";

export function attachRealtime(
  server: HttpServer,
  handlers: {
    getAlerts: () => Alert[];
    getWatchlist: () => string[];
    getSignals: () => any; // NEW
  }
) {
  const io = new IOServer(server, { cors: { origin: "*" } });

  io.on("connection", (socket) => {
    socket.emit("init", {
      alerts: handlers.getAlerts(),
      symbols: handlers.getWatchlist(),
      signals: handlers.getSignals()
    });
  });

  return {
    broadcastAlert(alert: Alert) {
      io.emit("alert", alert);
    },
    broadcastWatchlist(symbols: string[]) {
      io.emit("watchlist", { symbols });
    },
    broadcastSignals(signals: any) {
      io.emit("signals", { signals });
    }
  };
}
