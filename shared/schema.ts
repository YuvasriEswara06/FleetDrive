import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ==========================================
// 1. USERS TABLE (Drivers & Dispatchers)
// ==========================================
export const users = pgTable("users", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull().default(""),
  role: text("role").notNull().default("driver"), // 'driver' | 'dispatcher'
  companyName: text("company_name").notNull().default(""),
  employeeId: text("employee_id").notNull().default(""),
  vehicleNo: text("vehicle_no").notNull().default(""),
  vehicleType: text("vehicle_type").notNull().default(""),
  fuelType: text("fuel_type").notNull().default(""),
  capacity: text("capacity").notNull().default(""),
  phoneNo: text("phone_no").notNull().default(""),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  name: true,
  role: true,
  companyName: true,
  employeeId: true,
  vehicleNo: true,
  vehicleType: true,
  fuelType: true,
  capacity: true,
  phoneNo: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// ==========================================
// 2. ORDERS TABLE (Delivery Stops & SLAs)
// ==========================================
export const orders = pgTable("orders", {
  id: varchar("id").primaryKey(), // e.g. ORD-3001
  customerName: text("customer_name").notNull(),
  address: text("address").notNull(),
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  status: text("status").notNull().default("upcoming"), // 'en_route' | 'upcoming' | 'completed' | 'cancelled'
  isUrgent: boolean("is_urgent").notNull().default(false),
  packageId: text("package_id").notNull(),
  weight: text("weight").notNull().default("2.5 kg"),
  timeWindow: text("time_window").notNull().default(""),
  deadline: text("deadline").notNull().default(""),
  sequenceOrder: integer("sequence_order").notNull().default(0),
  driverId: text("driver_id").default(""),
  phone: text("phone").default(""),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
});

export const insertOrderSchema = createInsertSchema(orders);
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof orders.$inferSelect;

// ==========================================
// 3. DRIVER TELEMETRY TABLE (Live GPS State)
// ==========================================
export const driverTelemetry = pgTable("driver_telemetry", {
  driverId: varchar("driver_id").primaryKey(),
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  speed: real("speed").default(0),
  heading: real("heading").default(0),
  status: text("status").notNull().default("online"), // 'online' | 'offline' | 'en_route' | 'idle'
  lastPing: text("last_ping").notNull(),
});

export const insertTelemetrySchema = createInsertSchema(driverTelemetry);
export type InsertTelemetry = z.infer<typeof insertTelemetrySchema>;
export type DriverTelemetry = typeof driverTelemetry.$inferSelect;

// ==========================================
// 4. NETWORK LOGS TABLE (Computer Networks Audit)
// ==========================================
export const networkLogs = pgTable("network_logs", {
  id: varchar("id").primaryKey(),
  timestamp: text("timestamp").notNull(),
  direction: text("direction").notNull(), // 'INBOUND' | 'OUTBOUND'
  eventType: text("event_type").notNull(), // 'LOCATION_PING', 'DISPATCH_URGENT', etc.
  clientId: text("client_id").notNull(),
  payloadBytes: integer("payload_bytes").notNull(),
  latencyMs: real("latency_ms").default(0),
  status: text("status").notNull().default("ACK_OK"), // 'ACK_OK' | 'SENT' | 'DROPPED'
});

export const insertNetworkLogSchema = createInsertSchema(networkLogs);
export type InsertNetworkLog = z.infer<typeof insertNetworkLogSchema>;
export type NetworkLog = typeof networkLogs.$inferSelect;
