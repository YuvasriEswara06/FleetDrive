import * as fs from "fs";
import * as path from "path";
import { eq } from "drizzle-orm";
import { db, isPostgresConfigured } from "./db";
import {
  users,
  orders,
  driverTelemetry,
  networkLogs,
  type User,
  type InsertUser,
  type Order,
  type InsertOrder,
  type DriverTelemetry,
  type InsertTelemetry,
  type NetworkLog,
  type InsertNetworkLog,
} from "@shared/schema";

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, data: Partial<InsertUser>): Promise<User | undefined>;

  // Orders
  getOrders(): Promise<Order[]>;
  getOrder(id: string): Promise<Order | undefined>;
  getOrdersByDriver(driverId: string): Promise<Order[]>;
  createOrder(order: InsertOrder): Promise<Order>;
  updateOrder(id: string, data: Partial<InsertOrder>): Promise<Order | undefined>;
  updateOrderSequence(reorderedOrders: Array<{ id: string; sequenceOrder: number; status?: string }>): Promise<Order[]>;

  // Driver Telemetry
  getDriverTelemetry(driverId: string): Promise<DriverTelemetry | undefined>;
  updateDriverTelemetry(telemetry: InsertTelemetry): Promise<DriverTelemetry>;
  getAllTelemetry(): Promise<DriverTelemetry[]>;

  // Network Logs (Computer Networks audit)
  logNetworkEvent(event: InsertNetworkLog): Promise<NetworkLog>;
  getNetworkLogs(limit?: number): Promise<NetworkLog[]>;
  getNetworkStats(): Promise<{
    totalPackets: number;
    avgLatencyMs: number;
    inboundCount: number;
    outboundCount: number;
  }>;
}

interface FileDataStore {
  users: User[];
  orders: Order[];
  telemetry: Record<string, DriverTelemetry>;
  networkLogs: NetworkLog[];
}

export class FileStorage implements IStorage {
  private filePath: string;
  private data: FileDataStore;

  constructor() {
    const dataDir = path.resolve(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.filePath = path.join(dataDir, "fleetdrive_db.json");
    this.data = this.loadData();
  }

  private loadData(): FileDataStore {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn("[FileStorage] Error reading storage file, initializing empty:", e);
    }
    return { users: [], orders: [], telemetry: {}, networkLogs: [] };
  }

  private saveData() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (e) {
      console.error("[FileStorage] Failed to persist data to disk:", e);
    }
  }

  // Users
  async getUser(id: string): Promise<User | undefined> {
    return this.data.users.find((u) => u.id === id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return this.data.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const newUser: User = {
      id: "usr-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7),
      username: insertUser.username,
      password: insertUser.password,
      name: insertUser.name || insertUser.username,
      role: insertUser.role || "driver",
      companyName: insertUser.companyName || "",
      employeeId: insertUser.employeeId || "",
      vehicleNo: insertUser.vehicleNo || "",
      vehicleType: insertUser.vehicleType || "",
      fuelType: insertUser.fuelType || "",
      capacity: insertUser.capacity || "",
      phoneNo: insertUser.phoneNo || "",
    };
    this.data.users.push(newUser);
    this.saveData();
    return newUser;
  }

  async updateUser(id: string, data: Partial<InsertUser>): Promise<User | undefined> {
    const idx = this.data.users.findIndex((u) => u.id === id);
    if (idx === -1) return undefined;
    this.data.users[idx] = { ...this.data.users[idx], ...data };
    this.saveData();
    return this.data.users[idx];
  }

  // Orders
  async getOrders(): Promise<Order[]> {
    return [...this.data.orders].sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0));
  }

  async getOrder(id: string): Promise<Order | undefined> {
    return this.data.orders.find((o) => o.id === id);
  }

  async getOrdersByDriver(driverId: string): Promise<Order[]> {
    return this.data.orders
      .filter((o) => o.driverId === driverId)
      .sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0));
  }

  async createOrder(order: InsertOrder): Promise<Order> {
    const newOrder: Order = {
      id: order.id || "ORD-" + Math.floor(1000 + Math.random() * 9000),
      customerName: order.customerName,
      address: order.address,
      lat: order.lat,
      lng: order.lng,
      status: order.status || "upcoming",
      isUrgent: order.isUrgent ?? false,
      packageId: order.packageId || "PKG-" + Math.floor(10000 + Math.random() * 90000),
      weight: order.weight || "2.5 kg",
      timeWindow: order.timeWindow || "",
      deadline: order.deadline || "",
      sequenceOrder: order.sequenceOrder ?? this.data.orders.length + 1,
      driverId: order.driverId || "",
      phone: order.phone || "",
      createdAt: order.createdAt || new Date().toISOString(),
      completedAt: order.completedAt || null,
    };
    this.data.orders.push(newOrder);
    this.saveData();
    return newOrder;
  }

  async updateOrder(id: string, data: Partial<InsertOrder>): Promise<Order | undefined> {
    const idx = this.data.orders.findIndex((o) => o.id === id);
    if (idx === -1) return undefined;
    this.data.orders[idx] = { ...this.data.orders[idx], ...data } as Order;
    this.saveData();
    return this.data.orders[idx];
  }

  async updateOrderSequence(
    reorderedOrders: Array<{ id: string; sequenceOrder: number; status?: string }>
  ): Promise<Order[]> {
    for (const update of reorderedOrders) {
      const idx = this.data.orders.findIndex((o) => o.id === update.id);
      if (idx !== -1) {
        this.data.orders[idx].sequenceOrder = update.sequenceOrder;
        if (update.status) {
          this.data.orders[idx].status = update.status;
        }
      }
    }
    this.saveData();
    return this.getOrders();
  }

  // Driver Telemetry
  async getDriverTelemetry(driverId: string): Promise<DriverTelemetry | undefined> {
    return this.data.telemetry[driverId];
  }

  async updateDriverTelemetry(telemetry: InsertTelemetry): Promise<DriverTelemetry> {
    const record: DriverTelemetry = {
      driverId: telemetry.driverId,
      lat: telemetry.lat,
      lng: telemetry.lng,
      speed: telemetry.speed ?? 0,
      heading: telemetry.heading ?? 0,
      status: telemetry.status || "online",
      lastPing: telemetry.lastPing || new Date().toISOString(),
    };
    this.data.telemetry[telemetry.driverId] = record;
    this.saveData();
    return record;
  }

  async getAllTelemetry(): Promise<DriverTelemetry[]> {
    return Object.values(this.data.telemetry);
  }

  // Network Logs (Computer Networks)
  async logNetworkEvent(event: InsertNetworkLog): Promise<NetworkLog> {
    const logEntry: NetworkLog = {
      id: event.id || "pkt-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6),
      timestamp: event.timestamp || new Date().toISOString(),
      direction: event.direction,
      eventType: event.eventType,
      clientId: event.clientId,
      payloadBytes: event.payloadBytes,
      latencyMs: event.latencyMs ?? 0,
      status: event.status || "ACK_OK",
    };
    this.data.networkLogs.unshift(logEntry);
    // Keep last 500 packets in memory
    if (this.data.networkLogs.length > 500) {
      this.data.networkLogs = this.data.networkLogs.slice(0, 500);
    }
    this.saveData();
    return logEntry;
  }

  async getNetworkLogs(limit = 50): Promise<NetworkLog[]> {
    return this.data.networkLogs.slice(0, limit);
  }

  async getNetworkStats(): Promise<{
    totalPackets: number;
    avgLatencyMs: number;
    inboundCount: number;
    outboundCount: number;
  }> {
    const logs = this.data.networkLogs;
    const totalPackets = logs.length;
    const inboundCount = logs.filter((l) => l.direction === "INBOUND").length;
    const outboundCount = logs.filter((l) => l.direction === "OUTBOUND").length;
    const latencies = logs.filter((l) => (l.latencyMs ?? 0) > 0).map((l) => l.latencyMs ?? 0);
    const avgLatencyMs =
      latencies.length > 0
        ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2))
        : 4.8;

    return { totalPackets, avgLatencyMs, inboundCount, outboundCount };
  }
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async updateUser(id: string, data: Partial<InsertUser>): Promise<User | undefined> {
    const [user] = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return user;
  }

  async getOrders(): Promise<Order[]> {
    return await db.select().from(orders);
  }

  async getOrder(id: string): Promise<Order | undefined> {
    const [order] = await db.select().from(orders).where(eq(orders.id, id));
    return order;
  }

  async getOrdersByDriver(driverId: string): Promise<Order[]> {
    return await db.select().from(orders).where(eq(orders.driverId, driverId));
  }

  async createOrder(order: InsertOrder): Promise<Order> {
    const [newOrder] = await db.insert(orders).values(order).returning();
    return newOrder;
  }

  async updateOrder(id: string, data: Partial<InsertOrder>): Promise<Order | undefined> {
    const [updated] = await db.update(orders).set(data).where(eq(orders.id, id)).returning();
    return updated;
  }

  async updateOrderSequence(
    reorderedOrders: Array<{ id: string; sequenceOrder: number; status?: string }>
  ): Promise<Order[]> {
    for (const update of reorderedOrders) {
      await db
        .update(orders)
        .set({ sequenceOrder: update.sequenceOrder, ...(update.status ? { status: update.status } : {}) })
        .where(eq(orders.id, update.id));
    }
    return this.getOrders();
  }

  async getDriverTelemetry(driverId: string): Promise<DriverTelemetry | undefined> {
    const [record] = await db.select().from(driverTelemetry).where(eq(driverTelemetry.driverId, driverId));
    return record;
  }

  async updateDriverTelemetry(telemetry: InsertTelemetry): Promise<DriverTelemetry> {
    const [record] = await db
      .insert(driverTelemetry)
      .values(telemetry)
      .onConflictDoUpdate({ target: driverTelemetry.driverId, set: telemetry })
      .returning();
    return record;
  }

  async getAllTelemetry(): Promise<DriverTelemetry[]> {
    return await db.select().from(driverTelemetry);
  }

  async logNetworkEvent(event: InsertNetworkLog): Promise<NetworkLog> {
    const [log] = await db.insert(networkLogs).values(event).returning();
    return log;
  }

  async getNetworkLogs(limit = 50): Promise<NetworkLog[]> {
    return await db.select().from(networkLogs).limit(limit);
  }

  async getNetworkStats() {
    const logs = await this.getNetworkLogs(500);
    const totalPackets = logs.length;
    const inboundCount = logs.filter((l) => l.direction === "INBOUND").length;
    const outboundCount = logs.filter((l) => l.direction === "OUTBOUND").length;
    const latencies = logs.filter((l) => (l.latencyMs ?? 0) > 0).map((l) => l.latencyMs ?? 0);
    const avgLatencyMs =
      latencies.length > 0
        ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2))
        : 4.8;
    return { totalPackets, avgLatencyMs, inboundCount, outboundCount };
  }
}

// Automatically use PostgreSQL if configured, otherwise fallback to self-contained FileStorage
export const storage: IStorage =
  isPostgresConfigured && db ? new DatabaseStorage() : new FileStorage();

