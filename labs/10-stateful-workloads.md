# Lab 10 — Stateful Workloads, EBS, and Availability Zones

This lab runs a small StatefulSet on a dedicated On-Demand NodePool, provisions
one EBS volume per replica, and observes how volume topology constrains where
Karpenter can place replacement pods.

> EBS volumes incur AWS charges and are AZ-bound. Use a non-production cluster,
> keep the test data disposable, and check the volume reclaim policy before
> deleting PVCs.

---

## 1. Validate the Storage Prerequisites

This lab expects the EBS CSI driver and the `ebs-sc` StorageClass from
[Lab 00 — Prerequisites](./00-prerequisites.md):

```bash
kubectl get pods -n kube-system | grep ebs-csi
kubectl get storageclass ebs-sc -o yaml
```

Confirm the provisioner is `ebs.csi.aws.com` and
`volumeBindingMode: WaitForFirstConsumer`. If either is missing, stop and fix
the cluster storage prerequisites before continuing. Do not create a second
StorageClass with the same name.

---

## 2. Apply the Dedicated NodePool and Stateful Workload

The lab pool references the existing `default` EC2NodeClass, accepts only
On-Demand AMD64 instances, and allows Karpenter to disrupt no more than one
node at a time.

```bash
kubectl apply -f k8s/karpenter/nodepool-stateful-lab.yaml
kubectl apply -f k8s/labs/stateful-workload.yaml

kubectl rollout status statefulset/stateful-demo -n karpenter-stateful-lab
kubectl get pods,pvc -n karpenter-stateful-lab -o wide
kubectl get nodes -l nodepool=stateful-lab \
  -L topology.kubernetes.io/zone,karpenter.sh/capacity-type
```

Each StatefulSet replica gets its own PVC from `volumeClaimTemplates`.
Anti-affinity spreads replicas across hostnames. The first volume is provisioned
only after scheduling selects a node, which lets the scheduler and EBS CSI
driver agree on an Availability Zone.

Inspect each PVC and PV:

```bash
kubectl get pvc -n karpenter-stateful-lab
kubectl get pv
kubectl describe pv <pv-name>
```

Look for the PV's node affinity and compare its zone with the node running the
corresponding pod. EBS volumes can attach only to instances in their AZ.

---

## 3. Verify Data Survives Pod Replacement

The container appends timestamps to its per-replica volume. Check a log, delete
that pod, and wait for the StatefulSet to recreate it:

```bash
kubectl exec -n karpenter-stateful-lab stateful-demo-0 -- \
  sh -c 'until test -s /data/writes.log; do sleep 2; done; tail /data/writes.log'

kubectl delete pod stateful-demo-0 -n karpenter-stateful-lab
kubectl wait --for=condition=Ready pod/stateful-demo-0 \
  -n karpenter-stateful-lab --timeout=5m

kubectl exec -n karpenter-stateful-lab stateful-demo-0 -- \
  tail /data/writes.log
```

The PVC remains bound while the pod is replaced, so the new pod sees the
existing data. This verifies pod replacement and volume reattachment; it is not
a backup or cross-AZ disaster-recovery test.

---

## 4. Exercise a Controlled Node Drain

Confirm the test pods are on separate `stateful-lab` nodes before draining
either one:

```bash
kubectl get pods -n karpenter-stateful-lab -o wide
kubectl get nodes -l nodepool=stateful-lab
kubectl get pdb -n karpenter-stateful-lab
```

Find the node hosting `stateful-demo-0`, and verify it has the
`nodepool=stateful-lab` label before proceeding. This drain only makes
`stateful-demo-0` eligible for eviction; the PDB keeps the other replica
available:

```bash
STATEFUL_NODE=$(kubectl get pod stateful-demo-0 \
  -n karpenter-stateful-lab -o jsonpath='{.spec.nodeName}')
kubectl get node "$STATEFUL_NODE" -L nodepool
kubectl drain "$STATEFUL_NODE" --ignore-daemonsets \
  --delete-emptydir-data --timeout=10m
```

Watch the pod reschedule. If it remains Pending, inspect its events, the PVC's
AZ/node affinity, and Karpenter's logs. The replacement node must be in the
volume's AZ. When the test pod is Ready, uncordon the lab node:

```bash
kubectl get pods -n karpenter-stateful-lab -o wide
kubectl uncordon "$STATEFUL_NODE"
```

If the node does not show `nodepool=stateful-lab`, do not drain it.

Draining is a Kubernetes eviction operation, not a Karpenter repair operation.
Karpenter can provision capacity for pending pods, but `kubectl drain` itself
does not ask Karpenter to terminate the node.

---

## 5. Clean Up

> Deleting the namespace deletes the StatefulSet's PVCs. If the `ebs-sc`
> reclaim policy is `Delete`, Kubernetes will also delete the backing EBS
> volumes. Keep any data you need before cleanup.

```bash
kubectl delete namespace karpenter-stateful-lab
kubectl delete -f k8s/karpenter/nodepool-stateful-lab.yaml
kubectl get pv
```

Check for any retained PVs or EBS volumes left by your reclaim policy before
finishing.

---

## Production Takeaways

- Stateful workloads need topology-aware storage, realistic recovery
  objectives, and tested backups; a PVC alone is not disaster recovery.
- `WaitForFirstConsumer` coordinates initial scheduling and volume placement.
- Once provisioned, an EBS PV's zone constrains rescheduling after node loss.
- PDBs limit voluntary evictions; they do not make EBS volumes multi-AZ or
  protect against involuntary failures.

**Related:** [Lab 06 — Consolidation](./06-consolidation.md) ·
[Lab 09 — NodePool Disruption Budgets](./09-nodepool-disruption-budgets.md)
