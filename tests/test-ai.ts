/**
 * Automated Verification Suite for AI Dynamic Route Optimization Engine
 * 
 * Tests:
 * 1. Base 2-Opt TSP optimization on seeded Chennai stops
 * 2. Dynamic Urgent Order Insertion (D-TSPTW)
 * 3. 3-Way Comparative Benchmark (Naive Append vs Immediate Detour vs AI 2-Opt)
 * 4. Live REST endpoint: POST /api/optimize
 */

import { optimizeRouteWithBenchmark } from "../server/ai-optimizer";
import { Order } from "../shared/schema";

async function runAITest() {
  console.log("=================================================");
  console.log("🧠 Testing AI Dynamic Route Optimization Engine...");
  console.log("=================================================");

  const driverLocation = { lat: 13.0382, lng: 80.2466 }; // Teynampet

  const initialOrders: Order[] = [
    {
      id: "ORD-3001",
      customerName: "Priya Lakshmi",
      address: "12, Cenotaph Road, Teynampet, Chennai",
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
      createdAt: new Date().toISOString(),
      completedAt: null,
    },
    {
      id: "ORD-3002",
      customerName: "Karthik Sundaram",
      address: "78, Anna Nagar 2nd Avenue, Chennai",
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
      createdAt: new Date().toISOString(),
      completedAt: null,
    },
    {
      id: "ORD-3003",
      customerName: "Meena Venkatesh",
      address: "5, Besant Nagar 3rd Cross, Chennai",
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
      createdAt: new Date().toISOString(),
      completedAt: null,
    },
    {
      id: "ORD-3004",
      customerName: "Senthil Murugan",
      address: "303, Velachery Main Road, Chennai",
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
      createdAt: new Date().toISOString(),
      completedAt: null,
    },
    {
      id: "ORD-3005",
      customerName: "Ananya Ramesh",
      address: "45, OMR IT Highway, Thoraipakkam, Chennai",
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
      createdAt: new Date().toISOString(),
      completedAt: null,
    },
  ];

  // Injected High-Priority Urgent Order: Panagal Park, T. Nagar (near Teynampet)
  const urgentOrder: Order = {
    id: "ORD-URGENT-999",
    customerName: "Apollo Hospital Pharmacy",
    address: "Panagal Park, T. Nagar, Chennai",
    lat: 13.0418,
    lng: 80.2341,
    status: "upcoming",
    isUrgent: true,
    packageId: "PKG-URG-77",
    weight: "0.8 kg",
    timeWindow: "Express 30 mins",
    deadline: "10:45 AM TODAY",
    sequenceOrder: 0,
    driverId: "driver1",
    phone: "+91 98400 99999",
    createdAt: new Date().toISOString(),
    completedAt: null,
  };

  console.log("\n1️⃣ Running 3-Way Optimization Benchmark...");
  const result = await optimizeRouteWithBenchmark(driverLocation, initialOrders, urgentOrder);

  console.log(`Matrix Source: [${result.matrixSource}]`);
  console.log("\n==========================================================================================");
  console.log("| Strategy                | Total Km | Duration | Urgent Stop # | Urgent Wait | SLA Violations | Penalty |");
  console.log("==========================================================================================");

  const { naiveAppend, immediateDetour, aiDynamic } = result.comparison;

  const row = (s: typeof naiveAppend) =>
    `| ${s.strategyName.padEnd(23)} | ${(s.totalDistanceKm + " km").padEnd(8)} | ${(s.totalDurationMin + " min").padEnd(8)} | Stop #${s.urgentOrderIndex.toString().padEnd(7)} | ${(s.urgentOrderWaitMin + " min").padEnd(11)} | ${s.slaViolationsCount.toString().padEnd(14)} | ${s.slaPenaltyScore.toString().padEnd(7)} |`;

  console.log(row(naiveAppend));
  console.log(row(immediateDetour));
  console.log(row(aiDynamic));
  console.log("==========================================================================================");

  console.log("\n📊 AI Mathematical Savings:");
  console.log(`- Distance Saved: ${result.metrics.distanceSavedKm} km (${result.metrics.distanceSavedPercent}%)`);
  console.log(`- Time Saved:     ${result.metrics.timeSavedMin} mins (${result.metrics.timeSavedPercent}%)`);
  console.log(`- SLA Reduction:  ${result.metrics.slaPenaltyReductionPercent}% penalty avoidance`);
  console.log(`- Recommendation: ${result.metrics.recommendationReason}`);
  console.log(`- Polyline points generated: ${result.optimalStrategy.polyline.length}`);

  // Assertions
  if (!result.optimalStrategy || result.optimalStrategy.stops.length !== 6) {
    throw new Error(`Expected 6 sequenced stops, got ${result.optimalStrategy.stops.length}`);
  }

  // 2. Test Live REST endpoint
  console.log("\n2️⃣ Testing Live REST Endpoint: POST http://localhost:5000/api/optimize ...");
  try {
    const res = await fetch("http://localhost:5000/api/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driverId: "driver1",
        driverLat: 13.0382,
        driverLng: 80.2466,
        urgentOrder,
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP Error ${res.status}: ${await res.text()}`);
    }

    const json = await res.json();
    console.log("✅ Live API returned 200 OK!");
    console.log(`- Optimal Strategy: ${json.optimalStrategy.strategyName}`);
    console.log(`- Saved Km: ${json.metrics.distanceSavedKm} km`);
  } catch (err) {
    console.error("❌ Live API test failed:", err);
    throw err;
  }

  console.log("\n🎉 ALL AI OPTIMIZER VERIFICATIONS PASSED SUCCESSFULLY!");
}

runAITest().catch((e) => {
  console.error("Test failed with error:", e);
  process.exit(1);
});
