const express = require('express');
const os = require('os');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Read node metadata injected via Downward API environment variables
const POD_NAME = process.env.POD_NAME || 'unknown';
const NODE_NAME = process.env.NODE_NAME || 'unknown';
const NAMESPACE = process.env.NAMESPACE || 'default';

app.use(express.json());

// Health check — used by ALB target group health checks and Kubernetes liveness probe
app.get('/health', (req, res) => {
  res.json({ status: 'ok', pod: POD_NAME, node: NODE_NAME, ts: new Date().toISOString() });
});

// Readiness probe — separate from liveness so we can simulate degraded state
app.get('/ready', (req, res) => {
  res.json({ status: 'ready' });
});

// Returns node metadata including the Karpenter capacity type label.
// The frontend uses this to show whether the pod is on Spot or On-Demand.
app.get('/nodeinfo', (req, res) => {
  // Karpenter sets karpenter.sh/capacity-type label on nodes.
  // We read it from an env var injected via the Downward API fieldRef.
  const capacityType = process.env.CAPACITY_TYPE || 'unknown';
  res.json({
    podName: POD_NAME,
    nodeName: NODE_NAME,
    namespace: NAMESPACE,
    capacityType,
    hostname: os.hostname(),
    uptime: process.uptime(),
  });
});

// Simulated product catalog — static data, good for testing read scaling
app.get('/products', (req, res) => {
  const products = [
    { id: 1, name: 'EKS Cluster', price: 0.10, unit: 'per hour' },
    { id: 2, name: 'Karpenter Node (On-Demand)', price: 0.192, unit: 'per hour' },
    { id: 3, name: 'Karpenter Node (Spot)', price: 0.058, unit: 'per hour' },
    { id: 4, name: 'EBS Volume (gp3)', price: 0.08, unit: 'per GB-month' },
    { id: 5, name: 'ALB', price: 0.008, unit: 'per LCU-hour' },
  ];
  res.json({ products, servedBy: POD_NAME, node: NODE_NAME });
});

// CPU load simulator — drives Karpenter scale-out in Lab 04.
// Runs a tight loop for `duration` seconds to spike CPU usage.
// This triggers HPA to add replicas, which triggers Karpenter to add nodes.
app.get('/load', (req, res) => {
  const duration = Math.min(parseInt(req.query.duration) || 10, 120); // cap at 2 min
  const start = Date.now();

  // Burn CPU synchronously — intentionally blocks the event loop
  // to simulate a real CPU spike. In a real app this would be async work.
  while (Date.now() - start < duration * 1000) {
    Math.sqrt(Math.random() * 1e9);
  }

  res.json({
    message: `CPU load ran for ${duration}s`,
    pod: POD_NAME,
    node: NODE_NAME,
    durationMs: Date.now() - start,
  });
});

// Order endpoint — simulates a write operation with configurable latency
app.post('/orders', (req, res) => {
  const { items = [], simulateLatencyMs = 0 } = req.body;
  setTimeout(() => {
    res.json({
      orderId: `ORD-${Date.now()}`,
      items,
      status: 'confirmed',
      processedBy: POD_NAME,
    });
  }, simulateLatencyMs);
});

app.listen(PORT, () => {
  console.log(`Backend API running on port ${PORT}`);
  console.log(`Pod: ${POD_NAME} | Node: ${NODE_NAME}`);
});
