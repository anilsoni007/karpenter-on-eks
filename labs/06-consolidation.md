# Lab 06 — Consolidation

Consolidation is Karpenter's cost optimization engine. It continuously evaluates whether your nodes are efficiently utilized and replaces or removes them to reduce waste.

---

## Two Types of Consolidation

### 1. Empty Node Removal
A node with zero pods (excluding DaemonSets) is terminated immediately after `consolidateAfter`. This is the simplest case — no pod movement needed.

### 2. Underutilization Consolidation (Bin-Packing)
Karpenter simulates moving pods from underutilized nodes onto other existing nodes. If the simulation succeeds (all pods fit, PDBs are respected), Karpenter:
1. Cordons the underutilized node
2. Evicts its pods
3. Terminates the EC2 instance
4. Pods reschedule on the remaining nodes

**Why is this valuable?**  
After a traffic spike, you might have 5 nodes each at 20% utilization. Consolidation bin-packs those pods onto 1-2 nodes and terminates the rest, cutting your EC2 bill by 60-80%.

---

## 1. Create a Fragmented State

First, create a state where nodes are underutilized — this is what consolidation fixes.

```bash
# Scale up to create multiple nodes
kubectl scale deployment backend-api -n shopfront --replicas=10

# Wait for nodes to provision
kubectl get nodes -L karpenter.sh/nodepool -w

# Now scale back down — nodes are now underutilized but still running
kubectl scale deployment backend-api -n shopfront --replicas=2
```

Check the fragmented state:

```bash
kubectl get nodes -L karpenter.sh/nodepool,karpenter.sh/capacity-type
kubectl top nodes
```

You'll see nodes with low CPU/memory utilization. This is the state Karpenter's consolidation will fix.

---

## 2. Watch Consolidation Happen

```bash
# Watch nodes — you'll see some get cordoned then removed
kubectl get nodes -w

# Watch Karpenter's consolidation decisions
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter -f | \
  grep -i "consolidat\|disruption\|cordon\|evict"
```

After `consolidateAfter: 30s`, Karpenter will start bin-packing. You'll see log lines like:
```
disruption: consolidating node  node=ip-10-0-1-100  reason=underutilized
disruption: evicting pod  pod=backend-api-xyz  node=ip-10-0-1-100
disruption: node consolidated  savings=m5.large
```

---

## 3. Understand What Blocks Consolidation

Consolidation can be blocked by several things. Understanding these prevents confusion when nodes don't consolidate as expected.

### PodDisruptionBudgets
```bash
# If PDB says minAvailable=1 and only 1 pod exists, consolidation is blocked
kubectl get pdb -n shopfront
```

Karpenter respects PDBs. If evicting a pod would violate a PDB, Karpenter skips that node and tries again later.

### Pods with `do-not-disrupt` annotation
```bash
# Annotate a pod to prevent it from being evicted during consolidation
kubectl annotate pod <pod-name> -n shopfront \
  karpenter.sh/do-not-disrupt=true
```

**When to use this:**  
Long-running batch jobs that cannot be safely interrupted mid-run. The worker in this lab handles SIGTERM gracefully, so it doesn't need this annotation. But a database migration job or a checkpoint-less ML training job might.

### Pods with local storage (emptyDir, hostPath)
Pods using `emptyDir` volumes cannot be moved — the data would be lost. Karpenter will not consolidate nodes running such pods unless the pod explicitly sets `emptyDir.medium: Memory` (which is ephemeral by design).

---

## 4. Drift Detection

Drift occurs when a running node no longer matches its NodePool or EC2NodeClass specification. Common causes:
- You updated the NodePool requirements (e.g., added a new instance family)
- A new AMI was released and `expireAfter` triggered
- You changed the EC2NodeClass (e.g., new security group tag)

```bash
# Simulate drift by updating the NodePool to require a new label
kubectl patch nodepool general-purpose --type=merge -p '
{
  "spec": {
    "template": {
      "metadata": {
        "labels": {
          "updated": "true"
        }
      }
    }
  }
}'
```

Karpenter will detect that existing nodes don't have the `updated=true` label and will replace them via rolling disruption.

```bash
# Watch the rolling replacement
kubectl get nodes -w
kubectl get nodeclaims -w
```

**Why is drift replacement important in production?**  
This is your AMI rotation mechanism. When `expireAfter: 720h` triggers, Karpenter replaces nodes one at a time (respecting PDBs), ensuring all nodes run the latest patched AMI without any manual intervention.

---

## 5. Control Consolidation Aggressiveness

### Slow down consolidation (production setting)
```bash
kubectl patch nodepool general-purpose --type=merge -p '
{
  "spec": {
    "disruption": {
      "consolidateAfter": "5m"
    }
  }
}'
```

### Disable consolidation temporarily (e.g., during a deployment)
```bash
kubectl patch nodepool general-purpose --type=merge -p '
{
  "spec": {
    "disruption": {
      "consolidationPolicy": "WhenEmpty"
    }
  }
}'
```

`WhenEmpty` only removes completely empty nodes — it won't move pods. Use this during sensitive deployments when you don't want unexpected pod movements.

### Re-enable full consolidation
```bash
kubectl patch nodepool general-purpose --type=merge -p '
{
  "spec": {
    "disruption": {
      "consolidationPolicy": "WhenEmptyOrUnderutilized",
      "consolidateAfter": "30s"
    }
  }
}'
```

---

## 6. Observe Cost Savings

```bash
# Before consolidation — count nodes
kubectl get nodes -l karpenter.sh/nodepool=general-purpose --no-headers | wc -l

# After consolidation — count nodes again
# The difference × hourly instance cost = your savings
kubectl get nodes -l karpenter.sh/nodepool=general-purpose --no-headers | wc -l
```

In a real production cluster, Karpenter consolidation typically reduces node count by 30-60% compared to a cluster without it.

---

## Key Takeaways

| Scenario | Karpenter Action |
|----------|-----------------|
| Node has 0 pods | Terminates after `consolidateAfter` |
| Node is underutilized | Bin-packs pods, terminates node |
| PDB blocks eviction | Skips node, retries later |
| `do-not-disrupt` annotation | Skips that pod entirely |
| Node drifted from NodePool spec | Replaces node via rolling disruption |
| `expireAfter` reached | Replaces node (AMI rotation) |

**Next:** [Lab 07 — Advanced Scheduling](./07-advanced-scheduling.md)
