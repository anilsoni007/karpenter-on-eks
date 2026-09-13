# Lab 04 — Scaling Lab: Scale-Out and Scale-In

This lab demonstrates the full scaling chain: load → HPA adds pods → pods are unschedulable → Karpenter adds nodes. Then the reverse: load drops → HPA removes pods → nodes are empty → Karpenter removes nodes.

---

## The Scaling Chain

```
Load increases
    │
    ▼
CPU utilization rises on backend pods
    │
    ▼
HPA detects > 60% CPU → adds replicas
    │
    ▼
New pods are Pending (no node capacity)
    │
    ▼
Karpenter detects Pending pods → provisions node
    │
    ▼
Pods schedule → load handled

Load decreases (reverse)
    │
    ▼
HPA removes replicas (after 5min stabilization window)
    │
    ▼
Nodes become underutilized
    │
    ▼
Karpenter consolidates → terminates nodes
```

**Why does Karpenter wait for HPA to act first?**  
Karpenter only provisions nodes when pods are actually Pending. It doesn't pre-scale based on metrics. HPA is responsible for creating the pods; Karpenter is responsible for finding them a home.

---

## 1. Baseline — Check Current State

```bash
kubectl get pods -n shopfront
kubectl get nodes -L karpenter.sh/nodepool,karpenter.sh/capacity-type
kubectl get hpa -n shopfront
```

Note the current replica count and node count. You'll compare these after the load test.

---

## 2. Trigger Scale-Out

Open 4 terminals:

**Terminal 1 — Watch pods:**
```bash
kubectl get pods -n shopfront -w
```

**Terminal 2 — Watch nodes:**
```bash
kubectl get nodes -L karpenter.sh/nodepool,karpenter.sh/capacity-type -w
```

**Terminal 3 — Watch HPA:**
```bash
kubectl get hpa -n shopfront -w
```

**Terminal 4 — Generate load:**
```bash
ALB_URL=$(kubectl get ingress shopfront -n shopfront \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

# Send 50 concurrent requests to the CPU load endpoint
# Each request burns CPU for 30 seconds
for i in $(seq 1 50); do
  curl -s "http://${ALB_URL}/api/load?duration=30" &
done
wait
```

**What to observe:**
1. HPA detects CPU > 60% and starts adding replicas (~30s)
2. New pods enter `Pending` state — no room on existing nodes
3. Karpenter logs show it found provisionable pods
4. Karpenter picks an instance type and calls EC2 RunInstances
5. New node appears in `NotReady` then `Ready` (~60-90s total)
6. Pending pods schedule onto the new node

---

## 3. Understand Karpenter's Instance Selection

```bash
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter | grep "computed new nodeclaim"
```

You'll see output like:
```
computed new nodeclaim  instance-type=m5.xlarge  capacity-type=spot  zone=us-east-1b
```

**Why that instance type?**  
Karpenter runs a bin-packing simulation across all eligible instance types (from the NodePool requirements). It picks the cheapest option that can fit all currently-pending pods in a single node. If no single node can fit all pods, it may provision multiple nodes.

---

## 4. Observe Karpenter's Scheduling Decisions

```bash
# See what NodeClaims Karpenter created
kubectl get nodeclaims

# Describe a NodeClaim to see the full decision
kubectl describe nodeclaim <nodeclaim-name>
```

The NodeClaim shows:
- Which instance type was selected
- Which AZ it landed in
- Which NodePool it belongs to
- The exact resource requests that triggered it

---

## 5. Scale-In — Watch Consolidation

Stop the load (let the previous curl commands finish or kill them). Then wait for HPA to scale down:

```bash
# HPA has a 5-minute scale-down stabilization window
# Watch it reduce replicas
kubectl get hpa -n shopfront -w
```

Once replicas drop, watch Karpenter consolidate:

```bash
kubectl get nodes -L karpenter.sh/nodepool -w
```

After `consolidateAfter: 30s`, Karpenter will:
1. Identify nodes that are underutilized
2. Simulate moving pods to other nodes
3. If the simulation succeeds, cordon the node, evict pods, and terminate the EC2 instance

**Why doesn't Karpenter remove nodes immediately?**  
The `consolidateAfter: 30s` setting prevents thrashing. If Karpenter removed nodes the instant they became underutilized, a brief traffic dip would cause unnecessary node churn. In production, set this to `5m` or higher.

---

## 6. Manual Scale Test — Direct Deployment Scaling

You can also test Karpenter directly without HPA:

```bash
# Scale up to 15 replicas — will definitely need new nodes
kubectl scale deployment backend-api -n shopfront --replicas=15

# Watch Karpenter provision
kubectl get nodes -w

# Scale back down
kubectl scale deployment backend-api -n shopfront --replicas=2
```

---

## 7. Test the NodePool Limit

The `general-purpose` NodePool has a limit of 100 CPU. Try to exceed it:

```bash
kubectl scale deployment backend-api -n shopfront --replicas=100
```

Watch what happens when the limit is hit:

```bash
kubectl get nodeclaims
kubectl describe nodepool general-purpose | grep -A10 "Status"
```

Pods beyond the limit will remain `Pending` — Karpenter will log that it cannot provision more nodes due to the limit. This is the safety net working correctly.

```bash
# Clean up
kubectl scale deployment backend-api -n shopfront --replicas=2
```

---

## 8. Understand Spot vs On-Demand Selection

```bash
# Check which capacity type Karpenter chose for the new nodes
kubectl get nodes -L karpenter.sh/capacity-type
```

Karpenter prefers Spot when it's cheaper. You can see the price comparison in the logs:

```bash
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter | grep "spot"
```

**Why might Karpenter choose On-Demand even when Spot is allowed?**  
- Spot capacity is unavailable for the selected instance type in that AZ
- The Spot price is currently higher than On-Demand (rare but possible)
- The instance type doesn't have a Spot offering

---

## Key Observations

| Event | Karpenter Action | Time |
|-------|-----------------|------|
| Pod goes Pending | Evaluates instance types | ~5s |
| Instance type selected | Calls EC2 RunInstances | ~10s |
| EC2 instance running | Node joins cluster | ~60-90s |
| Node empty | Terminates instance | ~30s after `consolidateAfter` |
| Node underutilized | Bin-packs and terminates | ~30s after `consolidateAfter` |

**Next:** [Lab 05 — Spot Interruption Handling](./05-spot-interruption.md)
