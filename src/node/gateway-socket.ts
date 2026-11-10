import WebSocket, { type RawData } from "ws";

export interface GatewaySocketHandlers {
  open(): void;
  message(text: string): void;
  close(code: number, reason: string): void;
  error(error: Error): void;
}

export interface GatewaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type GatewaySocketFactory = (url: string, handlers: GatewaySocketHandlers) => GatewaySocket;

export const GATEWAY_SOCKET_OPEN = WebSocket.OPEN;

export const createNodeGatewaySocket: GatewaySocketFactory = (url, handlers) => {
  const socket = new WebSocket(url, {
    handshakeTimeout: 15_000,
    maxPayload: 16 * 1024 * 1024,
    perMessageDeflate: false,
  });
  socket.on("open", handlers.open);
  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    handlers.message(data.toString("utf8"));
  });
  socket.on("close", (code, reason) => handlers.close(code, reason.toString("utf8")));
  socket.on("error", handlers.error);
  return socket;
};
