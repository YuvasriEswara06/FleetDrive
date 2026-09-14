import { storage } from "./storage";

export async function seedDatabase() {
  console.log("=========================================");
  console.log("🌱 Seeding FleetDrive Database...");
  console.log("=========================================");

  // 1. Seed Accounts
  const existingDriver = await storage.getUserByUsername("driver1");
  if (!existingDriver) {
    console.log("Creating default Driver account (driver1)...");
    await storage.createUser({
      username: "driver1",
      password: "driver123",
      name: "Yuvasri Eswara",
      role: "driver",
      companyName: "FleetDrive Urban Logistics",
      employeeId: "FD-7701",
      vehicleNo: "TN 07 BK 4521",
      vehicleType: "Tata Ace EV",
      fuelType: "Electric",
      capacity: "1000 kg",
      phoneNo: "+91 98410 99887",
    });
  }

  const existingDispatcher = await storage.getUserByUsername("dispatcher");
  if (!existingDispatcher) {
    console.log("Creating default Dispatcher account (dispatcher)...");
    await storage.createUser({
      username: "dispatcher",
      password: "admin123",
      name: "Fleet Central Dispatch",
      role: "dispatcher",
      companyName: "FleetDrive Central Control",
      employeeId: "DISP-01",
      vehicleNo: "",
      vehicleType: "",
      fuelType: "",
      capacity: "",
      phoneNo: "+91 94440 12345",
    });
  }

  // 2. Seed Delivery Stops
  const existingOrders = await storage.getOrders();
  if (existingOrders.length === 0) {
    console.log("Seeding initial Chennai delivery route (5 stops)...");

    const initialStops = [
      {
        id: "ORD-3001",
        customerName: "Priya Lakshmi",
        address: "12, Cenotaph Road, Teynampet, Chennai 600018",
        lat: 13.0382,
        lng: 80.2466,
        status: "en_route",
        isUrgent: false,
        packageId: "PKG-55101",
        weight: "2.4 kg",
        timeWindow: "10:00 AM - 11:00 AM",
        deadline: "11:00 AM TODAY",
        sequenceOrder: 1,
        driverId: "driver1",
        phone: "+91 98410 12345",
      },
      {
        id: "ORD-3002",
        customerName: "Karthik Sundaram",
        address: "78, Anna Nagar 2nd Avenue, Chennai 600040",
        lat: 13.085,
        lng: 80.2101,
        status: "upcoming",
        isUrgent: false,
        packageId: "PKG-55102",
        weight: "5.1 kg",
        timeWindow: "11:00 AM - 12:00 PM",
        deadline: "12:00 PM TODAY",
        sequenceOrder: 2,
        driverId: "driver1",
        phone: "+91 94440 67890",
      },
      {
        id: "ORD-3003",
        customerName: "Meena Venkatesh",
        address: "5, Besant Nagar 3rd Cross, Chennai 600090",
        lat: 13.0002,
        lng: 80.2668,
        status: "upcoming",
        isUrgent: false,
        packageId: "PKG-55103",
        weight: "1.8 kg",
        timeWindow: "12:00 PM - 1:00 PM",
        deadline: "1:00 PM TODAY",
        sequenceOrder: 3,
        driverId: "driver1",
        phone: "+91 98765 11223",
      },
      {
        id: "ORD-3004",
        customerName: "Senthil Murugan",
        address: "303, Velachery Main Road, Chennai 600042",
        lat: 12.9815,
        lng: 80.218,
        status: "upcoming",
        isUrgent: false,
        packageId: "PKG-55104",
        weight: "3.2 kg",
        timeWindow: "1:00 PM - 2:00 PM",
        deadline: "2:00 PM TODAY",
        sequenceOrder: 4,
        driverId: "driver1",
        phone: "+91 98401 55667",
      },
      {
        id: "ORD-3005",
        customerName: "Ananya Ramesh",
        address: "45, OMR IT Highway, Thoraipakkam, Chennai 600097",
        lat: 12.9348,
        lng: 80.2312,
        status: "upcoming",
        isUrgent: false,
        packageId: "PKG-55105",
        weight: "4.0 kg",
        timeWindow: "2:00 PM - 3:00 PM",
        deadline: "3:00 PM TODAY",
        sequenceOrder: 5,
        driverId: "driver1",
        phone: "+91 98840 99001",
      },
    ];

    for (const stop of initialStops) {
      await storage.createOrder(stop);
    }
  }

  // 3. Seed Initial Driver Telemetry
  await storage.updateDriverTelemetry({
    driverId: "driver1",
    lat: 13.0382,
    lng: 80.2466,
    speed: 26.5,
    heading: 42,
    status: "en_route",
    lastPing: new Date().toISOString(),
  });

  console.log("✅ Seeding completed successfully!");
  console.log("Driver Login:      username: driver1    | password: driver123");
  console.log("Dispatcher Login:  username: dispatcher | password: admin123");
  console.log("=========================================");
}

// Allow direct execution: npx tsx server/seed.ts
if (require.main === module) {
  seedDatabase().catch((err) => {
    console.error("Seeding failed:", err);
    process.exit(1);
  });
}
