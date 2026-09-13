# Lab 07 — Advanced Scheduling

This lab covers production-grade scheduling patterns: topology spread, node affinity, multi-architecture (Graviton), and workload isolation using multiple NodePools.

---

## 1. Topology Spread Constraints

The ShopFront backend already has topology spread constraints. This section explains why they matter and how to verify they're working.

```bash
# Check which AZs your backend pods are in
kubectl get pods -n shopfront -l app=backend-api -o wide | \
  awk '{print $7}' | sort | uniq -c
```

**Why spread across AZs?**  
If all pods land in `us-east-1a` and that AZ has an issue, your entire backend goes down. Topology spread ensures pods are distributed across AZs so a single AZ failure only impacts a fraction of capacity.

**How Karpenter interacts with topology spread:**  
When Karpenter provisions a new node, it considers topology spread constraints. If the pending pod requires placement in `us-east-1b` (to satisfy the spread constraint), Karpenter will provision the node in a subnet in `us-east-1b` — not just any available subnet.

### Test topology spread enforcement

```bash
# Scale to 6 replicas — should spread 2 per AZ (assuming 3 AZs)
kubectl scale deployment backend-api -n shopfront --replicas=6

# Verify distribution
kubectl get pods -n shopfront -l app=backend-api -o wide
```

---

## 2. Node Affinity — Prefer Specific Instance Families

Use node affinity when you want to *prefer* certain nodes but not *require* them. Unlike `nodeSelector` (hard requirement), affinity supports soft preferences.

```bash
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-api-compute
  namespace: shopfront
spec:
  replicas: 2
  selector:
    matchLabels:
      app: backend-api-compute
  template:
    metadata:
      labels:
        app: backend-api-compute
    spec:
      affinity:
        nodeAffinity:
          # preferredDuringScheduling = soft preference, not a hard requirement.
          # If no compute-optimized node is available, the pod still schedules.
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 80
              preference:
                matchExpressions:
                  - key: karpenter.k8s.aws/instance-category
                    operator: In
                    values: ["c"]   # compute-optimized (c5, c6i, c7i)
          # requiredDuringScheduling = hard requirement.
          # Pod will NOT schedule unless this is satisfied.
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: karpenter.sh/nodepool
                    operator: In
                    values: ["general-purpose"]
      containers:
        - name: backend-api
          image: <AWS_ACCOUNT_ID>.dkr.ecr.<AWS_REGION>.amazonaws.com/shopfront-backend:latest
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
EOF
```

**Why use `preferredDuring` instead of `requiredDuring`?**  
Hard requirements can cause pods to remain Pending indefinitely if the constraint can't be satisfied. Soft preferences allow the scheduler to fall back gracefully. Use hard requirements only when the workload genuinely cannot run on other instance types.

---

## 3. Graviton (ARM64) NodePool

Graviton instances offer up to 40% better price/performance for many workloads. Create a dedicated NodePool for ARM workloads.

```bash
kubectl apply -f k8s/karpenter/nodepool-graviton.yaml
```

Then deploy a Graviton-targeted workload:

```bash
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-api-graviton
  namespace: shopfront
spec:
  replicas: 2
  selector:
    matchLabels:
      app: backend-api-graviton
  template:
    metadata:
      labels:
        app: backend-api-graviton
    spec:
      # Hard requirement — only run on ARM64 nodes
      nodeSelector:
        kubernetes.io/arch: arm64
        nodepool: graviton
      containers:
        - name: backend-api
          # Your image must be built for linux/arm64.
          # Use docker buildx to build multi-arch images.
          image: <AWS_ACCOUNT_ID>.dkr.ecr.<AWS_REGION>.amazonaws.com/shopfront-backend:latest
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
EOF
```

**Building multi-arch images:**
```bash
# Build for both amd64 and arm64, push a manifest list
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ${ECR_BASE}/shopfront-backend:latest \
  --push \
  app/backend/
```

When Kubernetes pulls the image on an ARM node, it automatically selects the `linux/arm64` layer from the manifest list.

---

## 4. Workload Isolation with Multiple NodePools

Production clusters typically have multiple NodePools for different workload classes:

```
NodePool: system          → Karpenter itself, monitoring, logging
NodePool: general-purpose → Web tier, APIs (On-Demand + Spot)
NodePool: spot-batch      → Workers, batch jobs (Spot only)
NodePool: graviton        → Cost-optimized stateless services (ARM)
```

**How to force a workload to a specific NodePool:**

```bash
# Option 1: nodeSelector (hard requirement)
nodeSelector:
  nodepool: spot-batch

# Option 2: nodeAffinity (soft preference)
affinity:
  nodeAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        preference:
          matchExpressions:
            - key: nodepool
              operator: In
              values: ["graviton"]
```

---

## 5. Pod Anti-Affinity — Never Co-locate Critical Pods

For high-availability, ensure that no two replicas of a critical service land on the same node:

```bash
kubectl patch deployment backend-api -n shopfront --type=merge -p '
{
  "spec": {
    "template": {
      "spec": {
        "affinity": {
          "podAntiAffinity": {
            "requiredDuringSchedulingIgnoredDuringExecution": [{
              "labelSelector": {
                "matchLabels": {"app": "backend-api"}
              },
              "topologyKey": "kubernetes.io/hostname"
            }]
          }
        }
      }
    }
  }
}'
```

**What this does:**  
No two `backend-api` pods can land on the same node. If you have 3 replicas, Karpenter must provision at least 3 nodes (or use 3 existing nodes). This is a hard requirement — if only 2 nodes are available, the 3rd pod stays Pending.

**When to use this vs topology spread:**  
- Anti-affinity: absolute guarantee — never co-locate (use for databases, stateful services)
- Topology spread: best-effort distribution — spread evenly but allow co-location if needed (use for stateless services)

---

## 6. Karpenter-Aware Scheduling Labels

Karpenter exposes rich labels on nodes that you can use in scheduling decisions:

```bash
kubectl get nodes -L \
  karpenter.sh/capacity-type,\
  karpenter.k8s.aws/instance-family,\
  karpenter.k8s.aws/instance-size,\
  karpenter.k8s.aws/instance-cpu,\
  karpenter.k8s.aws/instance-memory,\
  topology.kubernetes.io/zone
```

Use these in node affinity rules to target specific instance characteristics:

```yaml
# Only schedule on instances with >= 8 vCPUs
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
        - matchExpressions:
            - key: karpenter.k8s.aws/instance-cpu
              operator: Gt
              values: ["7"]
```

---

## Key Takeaways

| Pattern | Use Case |
|---------|----------|
| Topology spread | Distribute stateless pods across AZs/nodes |
| Node affinity (soft) | Prefer instance families without hard-blocking |
| Node affinity (hard) | Require specific node characteristics |
| Pod anti-affinity | Guarantee no co-location (HA for stateful) |
| Multiple NodePools | Workload isolation, cost tiers |
| Graviton NodePool | 40% better price/performance for compatible workloads |

**Next:** [Lab 08 — Production Best Practices](./08-production-best-practices.md)
