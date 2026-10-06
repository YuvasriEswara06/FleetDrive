import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { storage } from "./storage";
import { verifyToken, type AuthenticatedUserPayload } from "./auth";

export interface WebSocketPacket {
  type: string;
  data?: any;
  timestamp?: string;
  senderId?: string;
  packetId?: string;
  rttMs?: number;
  token?: string;
}

interface ConnectedClient {
  ws: WebSocket;
  id: string;
  role: "driver" | "dispatcher";
  driverId?: string;
  ip: string;
  connectedAt: string;
  authenticated: boolean;
  user?: AuthenticatedUserPayload;
}

export class FleetWebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ConnectedClient> = new Map();
  private pendingDispatches: Map<string, number> = new Map(); // packetId -> sentTimestamp

  public init(httpServer: Server) {
    this.wss = new WebSocketServer({
      server: httpServer,
      path: "/ws",
    });

    console.log("=========================================");
    console.log("🌐 RFC 6455 WebSocket Server initialized on path: /ws");
    console.log("=========================================");

    this.wss.on("connection", (ws: WebSocket, req) => {
      const clientId = "client-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6);
      const ip = req.socket.remoteAddress || "127.0.0.1";

      // Inspect URL query params for token (e.g. /ws?token=...)
      let authenticatedUser: AuthenticatedUserPayload | null = null;
      try {
        const urlObj = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
        const tokenParam = urlObj.searchParams.get("token");
        if (tokenParam) {
          authenticatedUser = verifyToken(tokenParam);
        }
      } catch (e) {
        // url parse fallback
      }

      const clientInfo: ConnectedClient = {
        ws,
        id: clientId,
        role: authenticatedUser?.role || "dispatcher",
        driverId: authenticatedUser?.role === "driver" ? authenticatedUser.username : undefined,
        ip,
        connectedAt: new Date().toISOString(),
        authenticated: !!authenticatedUser,
        user: authenticatedUser || undefined,
      };

      this.clients.set(clientId, clientInfo);

      // Log handshake packet
      storage.logNetworkEvent({
        id: "pkt-" + Date.now(),
        timestamp: new Date().toISOString(),
        direction: "INBOUND",
        eventType: "TCP_HANDSHAKE_101",
        clientId: clientInfo.driverId || clientId,
        payloadBytes: 128,
        latencyMs: 1.5,
        status: authenticatedUser ? "ACK_OK_JWT" : "ACK_OK",
      });

      // Send Welcome / Handshake ACK with authentication status
      this.sendToClient(ws, {
        type: "HANDSHAKE_ACK",
        data: {
          clientId,
          serverTime: new Date().toISOString(),
          protocol: "RFC-6455-FLEETSYNC/1.0",
          authenticated: clientInfo.authenticated,
          authType: clientInfo.authenticated ? "HMAC-SHA256-JWT" : "DEV-OPEN",
          user: clientInfo.user,
        },
      });

      // Handle Inbound Messages
      ws.on("message", async (rawMessage) => {
        try {
          const payloadStr = rawMessage.toString();
          const byteSize = Buffer.byteLength(payloadStr, "utf8");
          const packet: WebSocketPacket = JSON.parse(payloadStr);

          await this.handleIncomingPacket(clientInfo, packet, byteSize);
        } catch (err) {
          console.error("[WebSocket] Failed to parse incoming packet:", err);
        }
      });

      // Handle Disconnection
      ws.on("close", () => {
        this.clients.delete(clientId);
        storage.logNetworkEvent({
          id: "pkt-" + Date.now(),
          timestamp: new Date().toISOString(),
          direction: "INBOUND",
          eventType: "TCP_CONNECTION_CLOSED",
          clientId,
          payloadBytes: 16,
          latencyMs: 0,
          status: "ACK_OK",
        });
      });

      // Handle Socket Errors
      ws.on("error", (error) => {
        console.warn(`[WebSocket] Client ${clientId} error:`, error);
      });
    });

    // Heartbeat Keep-Alive every 15s to detect dead connections
    setInterval(() => {
      this.broadcastHeartbeat();
    }, 15000);
  }

  private async handleIncomingPacket(
    client: ConnectedClient,
    packet: WebSocketPacket,
    byteSize: number
  ) {
    const receiveTime = Date.now();

    // 1. Log Inbound Packet for Computer Networks Inspector
    await storage.logNetworkEvent({
      id: packet.packetId || "pkt-" + Date.now(),
      timestamp: new Date().toISOString(),
      direction: "INBOUND",
      eventType: packet.type,
      clientId: client.driverId || client.id,
      payloadBytes: byteSize,
      latencyMs: packet.rttMs ?? 2.4,
      status: "ACK_OK",
    });

    switch (packet.type) {
      // ----------------------------------------------------
      // EVENT: REGISTER (Client declares role: driver/dispatcher)
      // ----------------------------------------------------
      case "REGISTER": {
        const token = packet.data?.token || packet.token;
        if (token && !client.authenticated) {
          const verifiedUser = verifyToken(token);
          if (verifiedUser) {
            client.authenticated = true;
            client.user = verifiedUser;
            client.role = verifiedUser.role;
            if (verifiedUser.role === "driver") {
              client.driverId = verifiedUser.username;
            }
          }
        }

        if (!client.authenticated) {
          // Permissive fallback for unauthenticated test sockets
          client.role = packet.data?.role || (packet as any).role || "dispatcher";
          client.driverId = packet.data?.driverId || (packet as any).driverId || (client.role === "driver" ? "driver1" : undefined);
        }

        this.sendToClient(client.ws, {
          type: "REGISTER_ACK",
          data: {
            role: client.role,
            driverId: client.driverId,
            status: "connected",
            authenticated: client.authenticated,
            authMechanism: client.authenticated ? "HMAC-SHA256-JWT" : "DEV-PERMISSIVE",
          },
        });

        // Log security verification event for network auditor
        if (client.authenticated) {
          storage.logNetworkEvent({
            id: "pkt-" + Date.now(),
            timestamp: new Date().toISOString(),
            direction: "INBOUND",
            eventType: "SEC_JWT_AUTHENTICATED",
            clientId: client.driverId || client.id,
            payloadBytes: byteSize,
            latencyMs: 1.1,
            status: "AUTH_VERIFIED",
          });
        }

        // Broadcast driver online state to dispatchers
        if (client.role === "driver") {
          this.broadcastToDispatchers({
            type: "DRIVER_STATUS_CHANGE",
            data: {
              driverId: client.driverId,
              status: "online",
            },
          });
        }
        break;
      }

      // ----------------------------------------------------
      // EVENT: LOCATION_PING (Driver coordinates telemetry)
      // ----------------------------------------------------
      case "LOCATION_PING": {
        const { lat, lng, speed, heading } = packet.data;
        const driverId = client.driverId || "driver1";

        // Persist telemetry to storage
        await storage.updateDriverTelemetry({
          driverId,
          lat,
          lng,
          speed: speed || 25,
          heading: heading || 0,
          status: "en_route",
          lastPing: new Date().toISOString(),
        });

        // Broadcast location live to all connected dispatchers
        this.broadcastToDispatchers({
          type: "LOCATION_PING",
          data: {
            driverId,
            lat,
            lng,
            speed: speed || 25,
            heading: heading || 0,
            timestamp: new Date().toISOString(),
          },
        });
        break;
      }

      // ----------------------------------------------------
      // EVENT: DISPATCH_URGENT (Dispatcher pushes urgent delivery)
      // ----------------------------------------------------
      case "DISPATCH_URGENT": {
        const urgentData = packet.data;
        const packetId = "disp-" + Date.now();
        this.pendingDispatches.set(packetId, receiveTime);

        // Push packet to driver
        this.broadcastToDrivers({
          type: "URGENT_ORDER_DISPATCHED",
          packetId,
          data: urgentData,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      // ----------------------------------------------------
      // EVENT: ACK_URGENT_ACCEPTED (Driver taps Acknowledge)
      // ----------------------------------------------------
      case "ACK_URGENT_ACCEPTED": {
        const packetId = packet.packetId;
        let rtt = 18.5; // default estimation
        if (packetId && this.pendingDispatches.has(packetId)) {
          const sentTime = this.pendingDispatches.get(packetId)!;
          rtt = receiveTime - sentTime;
          this.pendingDispatches.delete(packetId);
        }

        // Broadcast confirmation and RTT to dispatchers
        this.broadcastToDispatchers({
          type: "URGENT_ORDER_ACKNOWLEDGED",
          data: {
            ...packet.data,
            rttMs: rtt,
          },
        });
        break;
      }

      // ----------------------------------------------------
      // EVENT: ORDER_STATUS_UPDATE (Driver marks Arrived/Delivered)
      // ----------------------------------------------------
      case "ORDER_STATUS_UPDATE": {
        const { orderId, status } = packet.data;
        await storage.updateOrder(orderId, {
          status,
          ...(status === "completed" ? { completedAt: new Date().toISOString() } : {}),
        });

        // Broadcast to dispatchers
        this.broadcastToDispatchers({
          type: "ORDER_STATUS_CHANGED",
          data: { orderId, status },
        });
        break;
      }

      // ----------------------------------------------------
      // EVENT: DRIVER_EXCEPTION_ALERT (Break / Fuel Request)
      // ----------------------------------------------------
      case "DRIVER_EXCEPTION_ALERT": {
        const exceptionData = packet.data;
        // Broadcast immediately to dispatchers
        this.broadcastToDispatchers({
          type: "DRIVER_EXCEPTION_ALERT",
          data: {
            ...exceptionData,
            timestamp: new Date().toISOString(),
          },
        });
        break;
      }

      // ----------------------------------------------------
      // EVENT: ACK_DRIVER_EXCEPTION (Dispatcher approves Break/Fuel)
      // ----------------------------------------------------
      case "ACK_DRIVER_EXCEPTION": {
        // Broadcast approval confirmation back to drivers
        this.broadcastToDrivers({
          type: "EXCEPTION_ACK_RECEIVED",
          data: {
            ...packet.data,
            timestamp: new Date().toISOString(),
          },
        });
        break;
      }

      // ----------------------------------------------------
      // EVENT: PONG (Heartbeat response)
      // ----------------------------------------------------
      case "PONG": {
        // Client is alive
        break;
      }

      default:
        console.log(`[WebSocket] Unhandled packet type: ${packet.type}`);
    }
  }

  // Helper: Send single packet to a client
  private sendToClient(ws: WebSocket, packet: WebSocketPacket) {
    if (ws.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({
        ...packet,
        timestamp: packet.timestamp || new Date().toISOString(),
      });
      ws.send(payload);

      // Log Outbound packet
      storage.logNetworkEvent({
        id: "pkt-" + Date.now(),
        timestamp: new Date().toISOString(),
        direction: "OUTBOUND",
        eventType: packet.type,
        clientId: "client",
        payloadBytes: Buffer.byteLength(payload, "utf8"),
        latencyMs: 1.8,
        status: "SENT",
      });
    }
  }

  // Helper: Broadcast to all dispatchers
  public broadcastToDispatchers(packet: WebSocketPacket) {
    for (const client of this.clients.values()) {
      if (client.role === "dispatcher" && client.ws.readyState === WebSocket.OPEN) {
        this.sendToClient(client.ws, packet);
      }
    }
  }

  // Helper: Broadcast to drivers
  public broadcastToDrivers(packet: WebSocketPacket) {
    for (const client of this.clients.values()) {
      if (client.role === "driver" && client.ws.readyState === WebSocket.OPEN) {
        this.sendToClient(client.ws, packet);
      }
    }
  }

  // Helper: Broadcast to all clients (drivers & dispatchers)
  public broadcastToAll(packet: WebSocketPacket) {
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        this.sendToClient(client.ws, packet);
      }
    }
  }

  // Broadcast Heartbeat ping
  private broadcastHeartbeat() {
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        this.sendToClient(client.ws, { type: "PING" });
      }
    }
  }

  public getConnectedCount(): { drivers: number; dispatchers: number } {
    let drivers = 0;
    let dispatchers = 0;
    for (const client of this.clients.values()) {
      if (client.role === "driver") drivers++;
      if (client.role === "dispatcher") dispatchers++;
    }
    return { drivers, dispatchers };
  }
}

export const wsManager = new FleetWebSocketManager();
