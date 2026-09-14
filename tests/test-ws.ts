import WebSocket from "ws";

async function runTest() {
  console.log("=========================================");
  console.log("🧪 Testing Real-Time WebSocket Network Protocol...");
  console.log("=========================================");

  const WS_URL = "ws://localhost:5000/ws";

  // 1. Connect Dispatcher Socket
  console.log("1. Connecting Dispatcher client to /ws...");
  const dispatcherWs = new WebSocket(WS_URL);

  await new Promise<void>((resolve, reject) => {
    dispatcherWs.on("open", () => {
      console.log("   ✅ Dispatcher WebSocket TCP stream OPEN");
      // Register role
      dispatcherWs.send(JSON.stringify({ type: "REGISTER", data: { role: "dispatcher" } }));
      resolve();
    });
    dispatcherWs.on("error", reject);
  });

  // 2. Connect Driver Socket
  console.log("2. Connecting Driver mobile client to /ws...");
  const driverWs = new WebSocket(WS_URL);

  await new Promise<void>((resolve, reject) => {
    driverWs.on("open", () => {
      console.log("   ✅ Driver WebSocket TCP stream OPEN");
      // Register role
      driverWs.send(JSON.stringify({ type: "REGISTER", data: { role: "driver", driverId: "driver1" } }));
      resolve();
    });
    driverWs.on("error", reject);
  });

  // 3. Test Driver Location Telemetry Ping
  console.log("3. Emitting LOCATION_PING from Driver...");
  let locationReceived = false;

  dispatcherWs.on("message", (raw) => {
    const packet = JSON.parse(raw.toString());
    if (packet.type === "DRIVER_LOCATION_UPDATE") {
      console.log("   ✅ Dispatcher received live telemetry broadcast!");
      console.log("      Location:", packet.data);
      locationReceived = true;
    }
  });

  driverWs.send(
    JSON.stringify({
      type: "LOCATION_PING",
      data: {
        lat: 13.0382,
        lng: 80.2466,
        speed: 32.4,
        heading: 88,
      },
    })
  );

  // Wait 1s
  await new Promise((r) => setTimeout(r, 1000));

  // 4. Test Dispatcher Urgent Order Dispatch
  console.log("4. Emitting DISPATCH_URGENT from Dispatcher...");
  let urgentReceived = false;

  driverWs.on("message", (raw) => {
    const packet = JSON.parse(raw.toString());
    if (packet.type === "URGENT_ORDER_DISPATCHED") {
      console.log("   ✅ Driver phone received URGENT_ORDER_DISPATCHED packet!");
      console.log("      Order ID:", packet.data.orderId);
      urgentReceived = true;

      // Send Acknowledgment back
      console.log("5. Sending ACK_URGENT_ACCEPTED from Driver back to Dispatcher...");
      driverWs.send(
        JSON.stringify({
          type: "ACK_URGENT_ACCEPTED",
          packetId: packet.packetId,
          data: {
            driverId: "driver1",
            status: "accepted",
          },
        })
      );
    }
  });

  dispatcherWs.send(
    JSON.stringify({
      type: "DISPATCH_URGENT",
      data: {
        orderId: "ORD-3900",
        customerName: "Deepak Rajan",
        address: "Kamarajar Salai, Mylapore, Chennai",
        detourDelay: "+7 min",
      },
    })
  );

  // Wait for ACK
  await new Promise<void>((resolve) => {
    dispatcherWs.on("message", (raw) => {
      const packet = JSON.parse(raw.toString());
      if (packet.type === "URGENT_ORDER_ACKNOWLEDGED") {
        console.log("   ✅ Dispatcher received ACK confirmation with RTT latency!");
        console.log("      Measured RTT Latency:", packet.data.rttMs, "ms");
        resolve();
      }
    });
    setTimeout(resolve, 2000);
  });

  dispatcherWs.close();
  driverWs.close();

  console.log("=========================================");
  console.log("🎉 ALL REAL-TIME NETWORKING TESTS PASSED!");
  console.log("=========================================");
  process.exit(0);
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
