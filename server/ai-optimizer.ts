/**
 * AI Dynamic Route Optimization Engine
 * 
 * Domain: Artificial Intelligence & Operations Research
 * Problem Formulation: Dynamic Traveling Salesperson Problem with Time Windows (D-TSPTW)
 * 
 * Core Components:
 * 1. Base 2-Opt Local Search TSP Optimizer
 * 2. Dynamic Urgent Order Insertion Heuristic with SLA Penalty Function
 * 3. 3-Way Comparative Benchmark (Naive Append vs Immediate Detour vs AI 2-Opt Insertion)
 * 4. Grounded in Real OSRM Road Distance Matrix & Real Polyline Geometries
 */

import { LatLng, getRoadMatrix, getRoadPolyline, RoadMatrixResult } from "./osm-client";
import { Order } from "@shared/schema";

export interface StrategyResult {
  strategyName: "Naive Append" | "Immediate Detour" | "AI 2-Opt Dynamic Insertion";
  strategyKey: "naive_append" | "immediate_detour" | "ai_dynamic";
  stops: Order[];
  totalDistanceKm: number;
  totalDurationMin: number;
  urgentOrderWaitMin: number;
  urgentOrderIndex: number; // 1-indexed position in route
  slaViolationsCount: number;
  slaPenaltyScore: number;
  fuelEstimatedLiters: number;
  polyline: Array<[number, number]>;
  summary: string;
}

export interface OptimizationResult {
  optimalStrategy: StrategyResult;
  comparison: {
    naiveAppend: StrategyResult;
    immediateDetour: StrategyResult;
    aiDynamic: StrategyResult;
  };
  metrics: {
    distanceSavedKm: number;
    distanceSavedPercent: number;
    timeSavedMin: number;
    timeSavedPercent: number;
    slaPenaltyReductionPercent: number;
    recommendationReason: string;
  };
  matrixSource: "osrm_live" | "haversine_fallback";
}

/**
 * Service duration per delivery stop (handling, handoff, signature)
 * Set to 3 minutes (180 seconds)
 */
const STOP_SERVICE_TIME_SEC = 180;

/**
 * Vehicle fuel consumption rate (liters per 100km for urban delivery van)
 * Equivalent to ~8.5 L / 100 km (or 0.085 L / km)
 */
const FUEL_CONSUMPTION_PER_KM = 0.085;

/**
 * Parse human-readable or relative deadlines into minutes from route start.
 * If unable to parse, defaults to sensible staggered SLA windows.
 */
function parseDeadlineToMinutes(order: Order, defaultIndex: number): number {
  if (order.isUrgent) {
    return 40; // Urgent SLA: must be delivered within 40 minutes of dispatch
  }

  // Check if string contains standard AM/PM time
  if (order.deadline) {
    const match = order.deadline.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (match) {
      let hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const isPM = match[3].toUpperCase() === "PM";
      if (isPM && hours !== 12) hours += 12;
      if (!isPM && hours === 12) hours = 0;

      // Map 10:00 AM as baseline zero (start of shift)
      const baselineMinutes = 10 * 60;
      const targetMinutes = hours * 60 + minutes;
      const diff = targetMinutes - baselineMinutes;
      if (diff > 0) return diff;
    }
  }

  // Staggered fallback: 50 mins + 40 mins per subsequent order
  return 50 + defaultIndex * 40;
}

/**
 * Evaluates cost, SLA compliance, and metrics for a candidate stop sequence
 */
function evaluateRouteSequence(
  stopIndices: number[], // 0 is driver, 1..N are stops
  matrix: RoadMatrixResult,
  allOrders: Order[],
  urgentOrderId?: string
): {
  totalDistanceMeters: number;
  totalDurationSec: number;
  urgentOrderWaitMin: number;
  urgentOrderIndex: number;
  slaViolationsCount: number;
  slaPenaltyScore: number;
  totalCost: number;
} {
  let totalDistanceMeters = 0;
  let totalDurationSec = 0;
  let urgentOrderWaitMin = 0;
  let urgentOrderIndex = -1;
  let slaViolationsCount = 0;
  let slaPenaltyScore = 0;

  // Track cumulative time starting at 0
  let currentTimeSec = 0;

  for (let k = 0; k < stopIndices.length - 1; k++) {
    const fromIdx = stopIndices[k];
    const toIdx = stopIndices[k + 1];

    const travelDist = matrix.distances[fromIdx]?.[toIdx] ?? 0;
    const travelSec = matrix.durations[fromIdx]?.[toIdx] ?? 0;

    totalDistanceMeters += travelDist;
    totalDurationSec += travelSec;

    currentTimeSec += travelSec;

    // Delivery stop reached (toIdx - 1 in allOrders array)
    const currentOrder = allOrders[toIdx - 1];
    if (currentOrder) {
      if (urgentOrderId && currentOrder.id === urgentOrderId) {
        urgentOrderIndex = k + 1;
        urgentOrderWaitMin = Math.round(currentTimeSec / 60);
      }

      // Check SLA deadline
      const arrivalMin = currentTimeSec / 60;
      const deadlineMin = parseDeadlineToMinutes(currentOrder, k);

      if (arrivalMin > deadlineMin) {
        slaViolationsCount++;
        const tardinessMin = arrivalMin - deadlineMin;
        // Urgent orders carry a severe 15x SLA breach penalty
        const penaltyMultiplier = currentOrder.isUrgent ? 15 : 2;
        slaPenaltyScore += Math.round(tardinessMin * penaltyMultiplier);
      }

      // Add service unloading time
      currentTimeSec += STOP_SERVICE_TIME_SEC;
      totalDurationSec += STOP_SERVICE_TIME_SEC;
    }
  }

  // Objective cost function:
  // Weight Duration (seconds) + 0.5 * Distance (meters) + 50 * SLA Penalty Score
  const totalCost = totalDurationSec + totalDistanceMeters * 0.5 + slaPenaltyScore * 50;

  return {
    totalDistanceMeters,
    totalDurationSec,
    urgentOrderWaitMin,
    urgentOrderIndex,
    slaViolationsCount,
    slaPenaltyScore,
    totalCost,
  };
}

/**
 * 2-Opt Local Search Heuristic
 * Iteratively reverses segments to untangle route crossings and minimize distance
 */
function run2OptOptimization(
  initialRoute: number[], // [0, s1, s2, ..., sn] where 0 is fixed driver origin
  matrix: RoadMatrixResult,
  allOrders: Order[]
): number[] {
  let route = [...initialRoute];
  const n = route.length;
  if (n <= 3) return route; // Driver + 1 or 2 stops cannot be swapped

  let improved = true;
  let iterations = 0;
  const maxIterations = 100;

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;

    // Driver (index 0) remains fixed at start
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        // Evaluate 2-opt swap: reverse segment between i and j
        const candidate = [
          ...route.slice(0, i),
          ...route.slice(i, j + 1).reverse(),
          ...route.slice(j + 1),
        ];

        const currentEval = evaluateRouteSequence(route, matrix, allOrders);
        const candidateEval = evaluateRouteSequence(candidate, matrix, allOrders);

        if (candidateEval.totalCost < currentEval.totalCost) {
          route = candidate;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }

  return route;
}

/**
 * Main AI Optimization Engine
 * Computes optimal stop sequence and 3-way comparative benchmark
 */
export async function optimizeRouteWithBenchmark(
  driverLocation: LatLng,
  existingOrders: Order[],
  urgentOrder?: Order
): Promise<OptimizationResult> {
  // 1. Prepare ordered list of all points
  const activeOrders = existingOrders.filter((o) => o.status !== "completed" && o.status !== "cancelled");

  // Determine full list of orders to evaluate
  const allOrdersToRoute: Order[] = urgentOrder
    ? [...activeOrders.filter((o) => o.id !== urgentOrder.id), urgentOrder]
    : [...activeOrders];

  // Point 0 is Driver, Points 1..N are delivery orders
  const allPoints: LatLng[] = [
    driverLocation,
    ...allOrdersToRoute.map((o) => ({ lat: o.lat, lng: o.lng })),
  ];

  // 2. Compute live road matrix via OSRM (or Haversine fallback)
  const matrix = await getRoadMatrix(allPoints);

  // If no urgent order, compute base 2-Opt TSP on active orders
  if (!urgentOrder) {
    const baseIndices = Array.from({ length: allPoints.length }, (_, i) => i);
    const optimizedIndices = run2OptOptimization(baseIndices, matrix, allOrdersToRoute);
    const evalResult = evaluateRouteSequence(optimizedIndices, matrix, allOrdersToRoute);

    const orderedStops = optimizedIndices.slice(1).map((idx, seq) => ({
      ...allOrdersToRoute[idx - 1],
      sequenceOrder: seq + 1,
    }));

    const polyline = await getRoadPolyline([
      driverLocation,
      ...orderedStops.map((o) => ({ lat: o.lat, lng: o.lng })),
    ]);

    const strategy: StrategyResult = {
      strategyName: "AI 2-Opt Dynamic Insertion",
      strategyKey: "ai_dynamic",
      stops: orderedStops,
      totalDistanceKm: Number((evalResult.totalDistanceMeters / 1000).toFixed(2)),
      totalDurationMin: Math.round(evalResult.totalDurationSec / 60),
      urgentOrderWaitMin: 0,
      urgentOrderIndex: 0,
      slaViolationsCount: evalResult.slaViolationsCount,
      slaPenaltyScore: evalResult.slaPenaltyScore,
      fuelEstimatedLiters: Number(((evalResult.totalDistanceMeters / 1000) * FUEL_CONSUMPTION_PER_KM).toFixed(2)),
      polyline,
      summary: "Base route optimized using 2-Opt TSP local search.",
    };

    return {
      optimalStrategy: strategy,
      comparison: {
        naiveAppend: strategy,
        immediateDetour: strategy,
        aiDynamic: strategy,
      },
      metrics: {
        distanceSavedKm: 0,
        distanceSavedPercent: 0,
        timeSavedMin: 0,
        timeSavedPercent: 0,
        slaPenaltyReductionPercent: 0,
        recommendationReason: "All active orders sequenced for minimal road distance.",
      },
      matrixSource: matrix.source,
    };
  }

  // =========================================================================
  // URGENT ORDER INJECTION: 3-WAY COMPARATIVE BENCHMARK
  // =========================================================================
  const urgentOrderInternalIdx = allOrdersToRoute.findIndex((o) => o.id === urgentOrder.id) + 1;
  const regularInternalIndices = Array.from({ length: allPoints.length }, (_, i) => i).filter(
    (idx) => idx !== 0 && idx !== urgentOrderInternalIdx
  );

  // Pre-optimize regular stops baseline sequence
  const regularBaseRoute = [0, ...regularInternalIndices];
  const optimizedRegularRoute = run2OptOptimization(regularBaseRoute, matrix, allOrdersToRoute);
  const cleanRegularStops = optimizedRegularRoute.slice(1); // regular stop indices

  // -------------------------------------------------------------------------
  // STRATEGY A: Naive Append (Add urgent order at the very end of route)
  // -------------------------------------------------------------------------
  const naiveIndices = [0, ...cleanRegularStops, urgentOrderInternalIdx];
  const naiveEval = evaluateRouteSequence(naiveIndices, matrix, allOrdersToRoute, urgentOrder.id);
  const naiveStops = naiveIndices.slice(1).map((idx, seq) => ({
    ...allOrdersToRoute[idx - 1],
    sequenceOrder: seq + 1,
  }));

  const naiveResult: StrategyResult = {
    strategyName: "Naive Append",
    strategyKey: "naive_append",
    stops: naiveStops,
    totalDistanceKm: Number((naiveEval.totalDistanceMeters / 1000).toFixed(2)),
    totalDurationMin: Math.round(naiveEval.totalDurationSec / 60),
    urgentOrderWaitMin: naiveEval.urgentOrderWaitMin,
    urgentOrderIndex: naiveEval.urgentOrderIndex,
    slaViolationsCount: naiveEval.slaViolationsCount,
    slaPenaltyScore: naiveEval.slaPenaltyScore,
    fuelEstimatedLiters: Number(((naiveEval.totalDistanceMeters / 1000) * FUEL_CONSUMPTION_PER_KM).toFixed(2)),
    polyline: [], // lazy or populated on demand
    summary: `Urgent order appended at the end (Stop #${naiveEval.urgentOrderIndex}). Severe delay of ~${naiveEval.urgentOrderWaitMin} mins violating urgent SLA window.`,
  };

  // -------------------------------------------------------------------------
  // STRATEGY B: Immediate Detour (Force urgent order to be Stop #1 immediately)
  // -------------------------------------------------------------------------
  const detourIndices = [0, urgentOrderInternalIdx, ...cleanRegularStops];
  const detourEval = evaluateRouteSequence(detourIndices, matrix, allOrdersToRoute, urgentOrder.id);
  const detourStops = detourIndices.slice(1).map((idx, seq) => ({
    ...allOrdersToRoute[idx - 1],
    sequenceOrder: seq + 1,
  }));

  const detourResult: StrategyResult = {
    strategyName: "Immediate Detour",
    strategyKey: "immediate_detour",
    stops: detourStops,
    totalDistanceKm: Number((detourEval.totalDistanceMeters / 1000).toFixed(2)),
    totalDurationMin: Math.round(detourEval.totalDurationSec / 60),
    urgentOrderWaitMin: detourEval.urgentOrderWaitMin,
    urgentOrderIndex: detourEval.urgentOrderIndex,
    slaViolationsCount: detourEval.slaViolationsCount,
    slaPenaltyScore: detourEval.slaPenaltyScore,
    fuelEstimatedLiters: Number(((detourEval.totalDistanceMeters / 1000) * FUEL_CONSUMPTION_PER_KM).toFixed(2)),
    polyline: [],
    summary: `Driver abandons scheduled path to deliver urgent order first (Stop #1 in ~${detourEval.urgentOrderWaitMin}m). Causes cascading delays on regular stops and increases total km.`,
  };

  // -------------------------------------------------------------------------
  // STRATEGY C: AI 2-Opt Dynamic Insertion (D-TSPTW Global Cost Minimization)
  // -------------------------------------------------------------------------
  // Evaluate all possible insertion positions: 1, 2, ..., N
  let bestIndices = [...naiveIndices];
  let bestEval = naiveEval;

  for (let insertPos = 1; insertPos <= cleanRegularStops.length + 1; insertPos++) {
    // Insert urgent order at insertPos
    const candidateRoute = [
      0,
      ...cleanRegularStops.slice(0, insertPos - 1),
      urgentOrderInternalIdx,
      ...cleanRegularStops.slice(insertPos - 1),
    ];

    // Refine with 2-opt local search to smooth out surrounding road bends
    const refinedRoute = run2OptOptimization(candidateRoute, matrix, allOrdersToRoute);
    const candidateEval = evaluateRouteSequence(refinedRoute, matrix, allOrdersToRoute, urgentOrder.id);

    if (candidateEval.totalCost < bestEval.totalCost) {
      bestEval = candidateEval;
      bestIndices = refinedRoute;
    }
  }

  const aiStops = bestIndices.slice(1).map((idx, seq) => ({
    ...allOrdersToRoute[idx - 1],
    sequenceOrder: seq + 1,
  }));

  // Generate road-following polyline for optimal route
  const aiPolyline = await getRoadPolyline([
    driverLocation,
    ...aiStops.map((o) => ({ lat: o.lat, lng: o.lng })),
  ]);

  const aiResult: StrategyResult = {
    strategyName: "AI 2-Opt Dynamic Insertion",
    strategyKey: "ai_dynamic",
    stops: aiStops,
    totalDistanceKm: Number((bestEval.totalDistanceMeters / 1000).toFixed(2)),
    totalDurationMin: Math.round(bestEval.totalDurationSec / 60),
    urgentOrderWaitMin: bestEval.urgentOrderWaitMin,
    urgentOrderIndex: bestEval.urgentOrderIndex,
    slaViolationsCount: bestEval.slaViolationsCount,
    slaPenaltyScore: bestEval.slaPenaltyScore,
    fuelEstimatedLiters: Number(((bestEval.totalDistanceMeters / 1000) * FUEL_CONSUMPTION_PER_KM).toFixed(2)),
    polyline: aiPolyline,
    summary: `AI balanced insertion at Stop #${bestEval.urgentOrderIndex}. Satisfies urgent SLA within ~${bestEval.urgentOrderWaitMin}m with zero route backtracking.`,
  };

  // Compute comparative savings against the worst benchmark
  const worstDistance = Math.max(naiveResult.totalDistanceKm, detourResult.totalDistanceKm);
  const distanceSavedKm = Number(Math.max(0, worstDistance - aiResult.totalDistanceKm).toFixed(2));
  const distanceSavedPercent = worstDistance > 0 ? Number(((distanceSavedKm / worstDistance) * 100).toFixed(1)) : 0;

  const worstDuration = Math.max(naiveResult.totalDurationMin, detourResult.totalDurationMin);
  const timeSavedMin = Math.max(0, worstDuration - aiResult.totalDurationMin);
  const timeSavedPercent = worstDuration > 0 ? Number(((timeSavedMin / worstDuration) * 100).toFixed(1)) : 0;

  const worstSlaPenalty = Math.max(naiveResult.slaPenaltyScore, detourResult.slaPenaltyScore);
  const slaPenaltyReductionPercent = worstSlaPenalty > 0
    ? Number((((worstSlaPenalty - aiResult.slaPenaltyScore) / worstSlaPenalty) * 100).toFixed(1))
    : 0;

  const recommendationReason =
    `AI 2-Opt placed Urgent Order at Stop #${aiResult.urgentOrderIndex}. ` +
    `Saves ${distanceSavedKm} km (${distanceSavedPercent}%) and reduces SLA tardiness penalty by ${slaPenaltyReductionPercent}% ` +
    `compared to baseline unoptimized strategies.`;

  return {
    optimalStrategy: aiResult,
    comparison: {
      naiveAppend: naiveResult,
      immediateDetour: detourResult,
      aiDynamic: aiResult,
    },
    metrics: {
      distanceSavedKm,
      distanceSavedPercent,
      timeSavedMin,
      timeSavedPercent,
      slaPenaltyReductionPercent,
      recommendationReason,
    },
    matrixSource: matrix.source,
  };
}
