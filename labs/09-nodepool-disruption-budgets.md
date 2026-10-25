# Lab 09 — NodePool Disruption Budgets

NodePool disruption budgets control how quickly Karpenter can voluntarily
disrupt nodes for operations such as consolidation and drift replacement. This
lab uses a dedicated NodePool manifest so you can inspect and experiment with
the budget configuration without changing `general-purpose`.

> Run the disruption experiment in a non-production cluster. The configuration
> below is an example; choose rates and maintenance hours that match your
> workload's availability requirements.

---

## NodePool Budgets, PodDisruptionBudgets, and NodePool Limits

These controls solve different problems:

| Control | What it limits |
| --- | --- |
| NodePool disruption budget (`spec.disruption.budgets`) | The rate of Karpenter-managed voluntary node disruptions |
| Kubernetes PodDisruptionBudget (PDB) | Which pod evictions can proceed while a node drains |
| NodePool `limits` | How much capacity Karpenter can provision |

Karpenter must satisfy both the NodePool disruption budget and pod-level
eviction constraints before a voluntary disruption can proceed. A NodePool
budget is not a replacement for application PDBs.

NodePool disruption budgets do not prevent involuntary events such as a Spot
interruption or node expiration, and they do not cap provisioning. Keep
workload recovery, replicas, and PDBs appropriate even when a disruption
budget is configured.

---

## 1. Create the Dedicated Lab NodePool

The lab NodePool uses the existing `default` EC2NodeClass, but has its own
label, capacity limits, and disruption policy:

```bash
kubectl apply -f k8s/karpenter/nodepool-budget-lab.yaml
kubectl get nodepool budget-lab -o yaml
```

This manifest is an independent NodePool. None of the steps in this lab patch
or otherwise modify `general-purpose`.

---

## 2. Provision Nodes in the Lab NodePool

Create a temporary workload that explicitly targets `budget-lab`. Required
pod anti-affinity makes the four replicas land on separate nodes, giving the
consolidation exercise empty nodes to observe:

```bash
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: budget-lab-inflate
  namespace: default
spec:
  replicas: 4
  selector:
    matchLabels:
      app: budget-lab-inflate
  template:
    metadata:
      labels:
        app: budget-lab-inflate
    spec:
      nodeSelector:
        nodepool: budget-lab
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: budget-lab-inflate
              topologyKey: kubernetes.io/hostname
      containers:
        - name: pause
          image: public.ecr.aws/eks-distro/kubernetes/pause:3.7
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
EOF

kubectl rollout status deployment/budget-lab-inflate
kubectl get nodes -l nodepool=budget-lab
```

The manifest's `10%` budget is the normal rate. Its scheduled zero budget
starts at 09:00 UTC on weekdays and lasts eight hours. During that window,
consolidation of underutilized nodes and drift replacement are paused. Change
the cron expression and duration in the manifest to match your maintenance
policy.

When more than one budget applies to a disruption reason, Karpenter uses the
most restrictive applicable budget. The `reasons` list scopes the scheduled
rule to underutilized-node consolidation and drift. Other disruption reasons
remain subject to the general `10%` budget.

---

## 3. Observe the Normal Budget

```bash
kubectl scale deployment budget-lab-inflate --replicas=1
kubectl get nodes -l nodepool=budget-lab -w
```

Once `consolidateAfter` elapses, Karpenter can remove empty lab nodes within
the active budget. Observe the NodePool and Karpenter events/logs:

```bash
kubectl describe nodepool budget-lab
kubectl get events -A --sort-by=.lastTimestamp
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter --since=10m
```

The lab pool's scheduled budget only applies to `Underutilized` and `Drifted`
reasons; the normal `10%` budget remains in effect for empty nodes.

---

## 4. Temporarily Block All Consolidation

Edit `k8s/karpenter/nodepool-budget-lab.yaml` and add this budget entry under
`spec.disruption.budgets`:

```yaml
      - nodes: "0"
        reasons:
          - Empty
          - Underutilized
          - Drifted
```

Apply the edited manifest and watch the lab nodes:

```bash
kubectl apply -f k8s/karpenter/nodepool-budget-lab.yaml
kubectl get nodes -l nodepool=budget-lab -w
```

Karpenter should stop voluntary empty-node, underutilized-node, and drift
disruptions for this NodePool while the zero budget is active. This budget
does not prevent involuntary events such as Spot interruptions.

Remove the temporary zero-budget entry from the manifest and apply it again:

```bash
kubectl apply -f k8s/karpenter/nodepool-budget-lab.yaml
```

Consolidation can resume according to the manifest's normal and scheduled
budgets.

---

## 5. Clean Up

```bash
kubectl delete deployment budget-lab-inflate
kubectl delete -f k8s/karpenter/nodepool-budget-lab.yaml
```

Deleting the lab NodePool removes only the `budget-lab` pool and its
NodeClaims; it leaves `general-purpose` unchanged.

---

## Production Design Checklist

- Use a conservative default disruption rate appropriate for pool size and
  workload tolerance; validate its impact on small pools.
- Use scheduled budgets for planned quiet hours or maintenance windows, and
  confirm the schedule is in UTC.
- Scope scheduled budgets with `reasons` so the maintenance window blocks only
  the disruption methods you intend.
- Keep PDBs for application availability; NodePool budgets do not replace
  them.
- Monitor pending workloads and disruption decisions, and test the policy
  before relying on it during a production maintenance window.

**Related:** [Lab 08 — Production Best Practices](./08-production-best-practices.md)
