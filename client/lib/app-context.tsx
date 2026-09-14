import React, {
  createContext,
  useContext,
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
  ReactNode,
} from "react";
import { ORDERS, NOTIFICATIONS, URGENT_ORDER, Order, Notification, UrgentOrderData } from "@/lib/mock-data";
import { getApiUrl, getWsUrl } from "@/lib/query-client";

interface AppContextValue {
  orders: Order[];
  notifications: Notification[];
  fuelRequested: boolean;
  breakRequested: boolean;
  fuelStopVisible: boolean;
  setFuelRequested: (v: boolean) => void;
  setBreakRequested: (v: boolean) => void;
  requestFuelStop: () => void;
  dismissNotification: (id: string) => void;
  acknowledgeNotification: (id: string) => void;
  unreadCount: number;
  urgentOrder: UrgentOrderData | null;
  urgentOverlayVisible: boolean;
  urgentAcknowledged: boolean;
  urgentMarkerVisible: boolean;
  voiceBotMessage: string | null;
  showUrgentOverlay: () => void;
  dismissUrgentOverlay: () => void;
  acknowledgeUrgentOrder: () => void;
  clearVoiceBotMessage: () => void;
  triggerUrgentDemo: () => void;
  wsConnected: boolean;
  driverLocation: { lat: number; lng: number };
  refreshOrders: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [orders, setOrders] = useState<Order[]>(ORDERS);
  const [notifications, setNotifications] = useState<Notification[]>(NOTIFICATIONS);
  const [fuelRequested, setFuelRequested] = useState(false);
  const [breakRequested, setBreakRequested] = useState(false);
  const [fuelStopVisible, setFuelStopVisible] = useState(false);

  const [urgentOrder, setUrgentOrder] = useState<UrgentOrderData | null>(null);
  const [urgentOverlayVisible, setUrgentOverlayVisible] = useState(false);
  const [urgentAcknowledged, setUrgentAcknowledged] = useState(false);
  const [urgentMarkerVisible, setUrgentMarkerVisible] = useState(false);
  const [voiceBotMessage, setVoiceBotMessage] = useState<string | null>(null);

  const [wsConnected, setWsConnected] = useState(false);
  const [driverLocation, setDriverLocation] = useState({ lat: 13.0382, lng: 80.2466 }); // Teynampet

  const wsRef = useRef<WebSocket | null>(null);
  const urgentPacketIdRef = useRef<string | null>(null);

  // 1. Fetch live orders from backend REST API
  const refreshOrders = useCallback(async () => {
    try {
      const apiUrl = getApiUrl();
      const res = await fetch(`${apiUrl}/api/orders`);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.orders) && data.orders.length > 0) {
          // Map backend schema to client Order format
          const mappedOrders: Order[] = data.orders.map((o: any) => ({
            id: o.id,
            customerName: o.customerName,
            address: o.address,
            eta: o.sequenceOrder ? `${o.sequenceOrder * 15} min` : "15 min",
            timeWindow: o.timeWindow || "10:00 AM - 12:00 PM",
            packageId: o.packageId || `PKG-${o.id}`,
            status: o.status || "upcoming",
            lat: o.lat,
            lng: o.lng,
            isUrgent: Boolean(o.isUrgent),
            weight: o.weight || "2.5 kg",
            deadline: o.deadline || "12:00 PM TODAY",
            phone: o.phone || "+91 98400 11223",
          }));
          setOrders(mappedOrders);
        }
      }
    } catch (err) {
      console.warn("[AppContext] Could not fetch live orders, using initial state:", err);
    }
  }, []);

  useEffect(() => {
    refreshOrders();
  }, [refreshOrders]);

  // 2. RFC 6455 WebSocket Connection & Telemetry Streaming
  useEffect(() => {
    let reconnectTimeout: any = null;
    let locationPingInterval: any = null;
    let isSubscribed = true;

    const connectWebSocket = () => {
      try {
        const wsUrl = getWsUrl();
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!isSubscribed) return;
          console.log("🌐 [Driver App] Connected to Fleet WebSocket:", wsUrl);
          setWsConnected(true);

          // Register client as driver
          ws.send(
            JSON.stringify({
              type: "REGISTER",
              role: "driver",
              driverId: "driver1",
            })
          );

          // Stream periodic LOCATION_PING telemetry
          locationPingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              // Add minor micro-movement around Chennai coordinates for live simulation
              setDriverLocation((prev) => {
                const nextLat = prev.lat + (Math.random() - 0.5) * 0.0003;
                const nextLng = prev.lng + (Math.random() - 0.5) * 0.0003;

                ws.send(
                  JSON.stringify({
                    type: "LOCATION_PING",
                    data: {
                      driverId: "driver1",
                      lat: nextLat,
                      lng: nextLng,
                      speed: 28.5 + (Math.random() * 4 - 2),
                      heading: 42,
                      status: "en_route",
                    },
                  })
                );

                return { lat: nextLat, lng: nextLng };
              });
            }
          }, 6000);
        };

        ws.onmessage = (event) => {
          if (!isSubscribed) return;
          try {
            const packet = JSON.parse(event.data);

            // Handle Urgent Order pushed from Dispatcher
            if (packet.type === "URGENT_ORDER_DISPATCHED") {
              const d = packet.data;
              urgentPacketIdRef.current = packet.packetId || null;

              const urgentData: UrgentOrderData = {
                order: {
                  id: d.id || "ORD-URGENT",
                  customerName: d.customerName || "Emergency Priority",
                  address: d.address || "Chennai",
                  eta: "6 min",
                  timeWindow: d.timeWindow || "Express 30 mins",
                  packageId: d.packageId || "PKG-URG",
                  status: "upcoming",
                  lat: d.lat || 13.0418,
                  lng: d.lng || 80.2341,
                  isUrgent: true,
                  weight: d.weight || "1.2 kg",
                  deadline: d.deadline || "ASAP TODAY",
                  phone: d.phone || "+91 94440 99999",
                },
                currentRouteEta: "1h 45m",
                newRouteEta: "1h 52m",
                reason: d.reason || "High-priority medical/express dispatch assigned by Central Dispatch.",
                weight: d.weight || "1.2 kg",
                deadline: d.deadline || "30 MINS",
              };

              setUrgentOrder(urgentData);
              setUrgentOverlayVisible(true);
              setUrgentAcknowledged(false);
              setUrgentMarkerVisible(false);
              setVoiceBotMessage("Priority urgent dispatch received from central control. Recalculating route...");

              setNotifications((prev) => [
                {
                  id: "NOTIF-URG-" + Date.now(),
                  title: "🚨 Urgent Order Dispatched!",
                  message: `${urgentData.order.customerName} - ${urgentData.order.address}. Please acknowledge.`,
                  time: "Just now",
                  read: false,
                  type: "urgent",
                },
                ...prev,
              ]);
            }

            // Handle AI Route Resequencing
            if (packet.type === "ROUTE_RESEQUENCED") {
              refreshOrders();
              setVoiceBotMessage("Route optimized and updated by Central Dispatch AI.");
              setNotifications((prev) => [
                {
                  id: "NOTIF-RES-" + Date.now(),
                  title: "⚡ Route Re-sequenced",
                  message: "Stops re-ordered for minimum SLA delay and optimal fuel usage.",
                  time: "Just now",
                  read: false,
                  type: "info",
                },
                ...prev,
              ]);
            }

            // Handle Ping Heartbeat
            if (packet.type === "PING") {
              ws.send(JSON.stringify({ type: "PONG" }));
            }
          } catch (err) {
            console.error("[AppContext] WebSocket packet processing error:", err);
          }
        };

        ws.onclose = () => {
          if (!isSubscribed) return;
          console.log("[Driver App] WebSocket closed. Reconnecting in 3s...");
          setWsConnected(false);
          clearInterval(locationPingInterval);
          reconnectTimeout = setTimeout(connectWebSocket, 3000);
        };

        ws.onerror = (err) => {
          console.warn("[Driver App] WebSocket error:", err);
          ws.close();
        };
      } catch (err) {
        console.error("[Driver App] Failed to establish WebSocket:", err);
        reconnectTimeout = setTimeout(connectWebSocket, 3000);
      }
    };

    connectWebSocket();

    return () => {
      isSubscribed = false;
      clearInterval(locationPingInterval);
      clearTimeout(reconnectTimeout);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [refreshOrders]);

  // Fallback demo trigger for offline presentation
  const triggerUrgentDemo = useCallback(() => {
    setUrgentOrder(URGENT_ORDER);
    setUrgentOverlayVisible(true);
    setUrgentAcknowledged(false);
    setUrgentMarkerVisible(false);
    setVoiceBotMessage("New urgent order added. Recalculating route for minimum delay.");
  }, []);

  const requestFuelStop = () => {
    setFuelStopVisible(true);
    setFuelRequested(true);
  };

  const dismissNotification = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  const acknowledgeNotification = (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
  };

  const showUrgentOverlay = useCallback(() => {
    setUrgentOverlayVisible(true);
  }, []);

  const dismissUrgentOverlay = useCallback(() => {
    setUrgentOverlayVisible(false);
  }, []);

  // Driver acknowledges urgent order -> Sends ACK_URGENT_ACCEPTED via WebSocket
  const acknowledgeUrgentOrder = useCallback(() => {
    if (!urgentOrder) return;
    setUrgentOverlayVisible(false);
    setUrgentAcknowledged(true);
    setUrgentMarkerVisible(true);

    // Send RFC 6455 ACK packet back to Central Dispatch
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "ACK_URGENT_ACCEPTED",
          packetId: urgentPacketIdRef.current || `pkt-${Date.now()}`,
          data: {
            orderId: urgentOrder.order.id,
            driverId: "driver1",
            driverName: "Yuvasri Eswara",
            acceptedAt: new Date().toISOString(),
          },
        })
      );
    }

    // Add urgent order into driver's active stop list
    setOrders((prev) => {
      const urgentExists = prev.some((o) => o.id === urgentOrder.order.id);
      if (urgentExists) return prev;
      const urgentOrderEntry: Order = {
        ...urgentOrder.order,
        status: "upcoming",
        isUrgent: true,
        weight: urgentOrder.weight,
        deadline: urgentOrder.deadline,
      };
      const enRoute = prev.filter((o) => o.status === "en_route");
      const upcoming = prev.filter((o) => o.status === "upcoming");
      const completed = prev.filter((o) => o.status === "completed");
      return [...enRoute, urgentOrderEntry, ...upcoming, ...completed];
    });

    setNotifications((prev) => [
      {
        id: "NOT-URGENT-" + Date.now(),
        title: "Urgent Order Acknowledged",
        message: `${urgentOrder.order.id} added to active route. ACK packet returned to Dispatcher.`,
        time: "Just now",
        read: false,
        type: "urgent",
      },
      ...prev,
    ]);
  }, [urgentOrder]);

  const clearVoiceBotMessage = useCallback(() => {
    setVoiceBotMessage(null);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const value = useMemo(
    () => ({
      orders,
      notifications,
      fuelRequested,
      breakRequested,
      fuelStopVisible,
      setFuelRequested,
      setBreakRequested,
      requestFuelStop,
      dismissNotification,
      acknowledgeNotification,
      unreadCount,
      urgentOrder,
      urgentOverlayVisible,
      urgentAcknowledged,
      urgentMarkerVisible,
      voiceBotMessage,
      showUrgentOverlay,
      dismissUrgentOverlay,
      acknowledgeUrgentOrder,
      clearVoiceBotMessage,
      triggerUrgentDemo,
      wsConnected,
      driverLocation,
      refreshOrders,
    }),
    [
      orders,
      notifications,
      fuelRequested,
      breakRequested,
      fuelStopVisible,
      urgentOrder,
      urgentOverlayVisible,
      urgentAcknowledged,
      urgentMarkerVisible,
      voiceBotMessage,
      unreadCount,
      showUrgentOverlay,
      dismissUrgentOverlay,
      acknowledgeUrgentOrder,
      clearVoiceBotMessage,
      triggerUrgentDemo,
      wsConnected,
      driverLocation,
      refreshOrders,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
}
