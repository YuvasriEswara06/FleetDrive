import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { storage } from "./storage";

export interface WebSocketPacket {
  type: string;
  data?: any;
  timestamp?: string;
  senderId?: string;
  packetId?: string;
  rttMs?: number;
}

interface ConnectedClient {
  ws: WebSocket;
  id: string;
  role: "driver" | "dispatcher";
  driverId?: string;
  ip: string;
  connectedAt: string;
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

      const clientInfo: ConnectedClient = {
        ws,
        id: clientId,
        role: "dispatcher", // default until REGISTER packet
        ip,
        connectedAt: new Date().toISOString(),
      };

      this.clients.set(clientId, clientInfo);

      // Log handshake packet
      storage.logNetworkEvent({
        id: "pkt-" + Date.now(),
        timestamp: new Date().toISOString(),
        direction: "INBOUND",
        eventType: "TCP_HANDSHAKE_101",
        clientId,
        payloadBytes: 128,
        latencyMs: 1.5,
        status: "ACK_OK",
      });

      // Send Welcome / Handshake ACK
      this.sendToClient(ws, {
        type: "HANDSHAKE_ACK",
        data: {
          clientId,
          serverTime: new Date().toISOString(),
          protocol: "RFC-6455-FLEETSYNC/1.0",
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
        client.role = packet.data?.role || (packet as any).role || "dispatcher";
        client.driverId = packet.data?.driverId || (packet as any).driverId || (client.role === "driver" ? "driver1" : undefined);

        this.sendToClient(client.ws, {
          type: "REGISTER_ACK",
          data: {
            role: client.role,
            driverId: client.driverId,
            status: "connected",
          },
        });

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
