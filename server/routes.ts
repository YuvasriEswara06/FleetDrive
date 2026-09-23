import type { Express } from "express";
import { createServer, type Server } from "node:http";
import { storage } from "./storage";
import { seedDatabase, resetDatabase } from "./seed";
import { geocodeAddress, getRoadMatrix, getRoadPolyline } from "./osm-client";
import { optimizeRouteWithBenchmark } from "./ai-optimizer";
import { wsManager } from "./websocket";

export async function registerRoutes(app: Express): Promise<Server> {
  // Auto-seed on startup if needed
  seedDatabase().catch((e) => console.error("Auto-seed error:", e));

  // ==========================================
  // AUTHENTICATION ROUTES
  // ==========================================
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required" });
      }

      const user = await storage.getUserByUsername(username);
      if (!user || user.password !== password) {
        return res.status(401).json({ message: "Invalid username or password" });
      }

      const { password: _, ...safeUser } = user;
      return res.json({ user: safeUser });
    } catch (error) {
      console.error("Login error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  app.post("/api/auth/signup", async (req, res) => {
    try {
      const { username, password, name, role, companyName, employeeId } = req.body;
      if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required" });
      }

      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(409).json({ message: "Username already taken" });
      }

      const user = await storage.createUser({
        username,
        password,
        name: name || username,
        role: role || "driver",
        companyName: companyName || "",
        employeeId: employeeId || "",
      });

      const { password: _, ...safeUser } = user;
      return res.json({ user: safeUser });
    } catch (error) {
      console.error("Signup error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/auth/user/:id", async (req, res) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      const { password: _, ...safeUser } = user;
      return res.json({ user: safeUser });
    } catch (error) {
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  app.put("/api/auth/user/:id", async (req, res) => {
    try {
      const { name, vehicleNo, vehicleType, fuelType, capacity, phoneNo } = req.body;
      const user = await storage.updateUser(req.params.id, {
        name,
        vehicleNo,
        vehicleType,
        fuelType,
        capacity,
        phoneNo,
      });
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      const { password: _, ...safeUser } = user;
      return res.json({ user: safeUser });
    } catch (error) {
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  // ==========================================
  // ORDERS MANAGEMENT ROUTES
  // ==========================================
  app.get("/api/orders", async (_req, res) => {
    try {
      const orders = await storage.getOrders();
      return res.json({ orders });
    } catch (error) {
      return res.status(500).json({ message: "Failed to fetch orders" });
    }
  });

  app.get("/api/orders/:id", async (req, res) => {
    try {
      const order = await storage.getOrder(req.params.id);
      if (!order) return res.status(404).json({ message: "Order not found" });
      return res.json({ order });
    } catch (error) {
      return res.status(500).json({ message: "Failed to fetch order" });
    }
  });

  app.post("/api/orders", async (req, res) => {
    try {
      const order = await storage.createOrder(req.body);
      return res.status(201).json({ order });
    } catch (error) {
      return res.status(400).json({ message: "Failed to create order" });
    }
  });

  app.patch("/api/orders/:id/status", async (req, res) => {
    try {
      const { status } = req.body;
      const updated = await storage.updateOrder(req.params.id, {
        status,
        ...(status === "completed" ? { completedAt: new Date().toISOString() } : {}),
      });
      if (!updated) return res.status(404).json({ message: "Order not found" });
      return res.json({ order: updated });
    } catch (error) {
      return res.status(500).json({ message: "Failed to update order status" });
    }
  });

  // ==========================================
  // LIVE OPENSTREETMAP & OSRM ROUTES
  // ==========================================
  app.get("/api/osm/geocode", async (req, res) => {
    try {
      const query = (req.query.q as string) || "";
      if (!query.trim()) {
        return res.status(400).json({ message: "Query parameter q is required" });
      }
      const result = await geocodeAddress(query);
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ message: "Geocoding failed" });
    }
  });

  app.post("/api/osm/matrix", async (req, res) => {
    try {
      const { points } = req.body; // Array of { lat, lng }
      if (!Array.isArray(points) || points.length === 0) {
        return res.status(400).json({ message: "points array is required" });
      }
      const matrix = await getRoadMatrix(points);
      return res.json(matrix);
    } catch (error) {
      return res.status(500).json({ message: "Matrix calculation failed" });
    }
  });

  app.post("/api/osm/route", async (req, res) => {
    try {
      const { points } = req.body; // Array of { lat, lng }
      if (!Array.isArray(points) || points.length < 2) {
        return res.status(400).json({ message: "At least 2 points required" });
      }
      const polyline = await getRoadPolyline(points);
      return res.json({ polyline });
    } catch (error) {
      return res.status(500).json({ message: "Route polyline calculation failed" });
    }
  });

  // ==========================================
  // AI DYNAMIC ROUTE OPTIMIZATION ROUTES (AI Focus)
  // ==========================================
  app.post("/api/optimize", async (req, res) => {
    try {
      const { driverId = "driver1", driverLat, driverLng, urgentOrderId, urgentOrder } = req.body;

      // 1. Determine driver location
      let driverLocation = { lat: 13.0382, lng: 80.2466 }; // default Teynampet
      if (typeof driverLat === "number" && typeof driverLng === "number") {
        driverLocation = { lat: driverLat, lng: driverLng };
      } else {
        const telemetry = await storage.getDriverTelemetry(driverId);
        if (telemetry) {
          driverLocation = { lat: telemetry.lat, lng: telemetry.lng };
        }
      }

      // 2. Fetch all orders
      const orders = await storage.getOrders();

      // 3. Resolve urgent order if provided
      let targetUrgentOrder = urgentOrder;
      if (!targetUrgentOrder && urgentOrderId) {
        targetUrgentOrder = orders.find((o) => o.id === urgentOrderId);
      }

      // 4. Run AI 2-Opt & Benchmark Engine
      const result = await optimizeRouteWithBenchmark(driverLocation, orders, targetUrgentOrder);
      return res.json(result);
    } catch (error) {
      console.error("[AI Optimize] Optimization failed:", error);
      return res.status(500).json({ message: "Route optimization failed", error: String(error) });
    }
  });

  app.post("/api/optimize/apply", async (req, res) => {
    try {
      const { orderedOrderIds, strategy = "ai_dynamic" } = req.body;
      if (!Array.isArray(orderedOrderIds) || orderedOrderIds.length === 0) {
        return res.status(400).json({ message: "orderedOrderIds array is required" });
      }

      // Update sequence orders in storage
      for (let i = 0; i < orderedOrderIds.length; i++) {
        const orderId = orderedOrderIds[i];
        await storage.updateOrder(orderId, { sequenceOrder: i + 1 });
      }

      const updatedOrders = await storage.getOrders();

      // Broadcast sequence update to Driver App and Dispatcher via WebSocket
      wsManager.broadcastToAll({
        type: "ROUTE_RESEQUENCED",
        data: {
          strategy,
          orderedOrderIds,
          timestamp: new Date().toISOString(),
        },
      });

      return res.json({
        message: "Route resequenced and broadcast to clients successfully",
        orders: updatedOrders,
      });
    } catch (error) {
      console.error("[AI Optimize] Apply sequence failed:", error);
      return res.status(500).json({ message: "Failed to apply sequence" });
    }
  });

  // ==========================================
  // TELEMETRY & NETWORK AUDIT ROUTES (CN Focus)
  // ==========================================
  app.get("/api/telemetry", async (_req, res) => {
    try {
      const telemetry = await storage.getAllTelemetry();
      return res.json({ telemetry });
    } catch (error) {
      return res.status(500).json({ message: "Failed to fetch telemetry" });
    }
  });

  app.get("/api/network/stats", async (_req, res) => {
    try {
      const stats = await storage.getNetworkStats();
      return res.json(stats);
    } catch (error) {
      return res.status(500).json({ message: "Failed to fetch network stats" });
    }
  });

  app.get("/api/network/logs", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const logs = await storage.getNetworkLogs(limit);
      return res.json({ logs });
    } catch (error) {
      return res.status(500).json({ message: "Failed to fetch network logs" });
    }
  });

  // ==========================================
  // DEMO RESET ENDPOINT
  // ==========================================
  app.post("/api/demo/reset", async (_req, res) => {
    try {
      // Re-seed orders and telemetry to baseline
      const orders = await resetDatabase();
      // Broadcast reset event so both Dispatcher and Driver immediately refresh
      wsManager.broadcastToAll({
        type: "ROUTE_RESEQUENCED",
        data: { orders },
        timestamp: new Date().toISOString(),
      });
      return res.json({ message: "Demo data reset successfully", orders });
    } catch (error) {
      return res.status(500).json({ message: "Failed to reset demo data" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
