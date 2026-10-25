# Lab 13 — Node Health and Auto Repair Readiness

This lab prepares you to operate Karpenter Node Auto Repair: identify unhealthy
nodes, verify the controller's prerequisites, understand repair budgets, and
monitor repair events. It does **not** inject a node failure. Deliberately
breaking a node can disrupt workloads and incur replacement costs; perform an
actual repair drill only in an isolated sandbox with disposable workloads.

---

## 1. Understand the Version-Specific Feature Gate

This repository installs Karpenter `1.14.1`. In that release,
`NodeRepair` is a feature gate and is disabled by default. Node Auto Repair
must be explicitly enabled for the controller. Check the version and current
settings:

```bash
helm list -n karpenter
kubectl get deployment karpenter -n karpenter \
  -o jsonpath='{.spec.template.spec.containers[0].env}'
kubectl get nodes -o wide
kubectl get nodeclaims
```

Read the [Karpenter v1.14 Node Auto Repair documentation](https://karpenter.sh/v1.14/concepts/disruption/#node-auto-repair)
and its [feature-gate reference](https://karpenter.sh/v1.14/reference/settings/#feature-gates)
before enabling it. Validate that the controller IAM role has the permissions
required by the version; Karpenter v1.14 upgrade guidance calls out
`ec2:DescribeInstanceStatus` for EC2 instance health checks. Do not replace
the entire controller policy with a partial example.

---

## 2. Enable Node Repair Only in a Disposable Cluster

This changes the Karpenter controller for the whole cluster. Skip this step
unless the cluster is a sandbox with no production workloads. Use the same
chart version as the existing installation and preserve its other values:

```bash
helm upgrade karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version 1.14.1 \
  --namespace karpenter \
  --reuse-values \
  --set settings.featureGates.nodeRepair=true \
  --wait
```

Verify the controller rolled out and the feature gate is present:

```bash
kubectl rollout status deployment/karpenter -n karpenter
kubectl get deployment karpenter -n karpenter \
  -o jsonpath='{.spec.template.spec.containers[0].env}'
```

If the IAM permission or feature-gate value is missing, stop and resolve that
before proceeding. Do not enable a feature gate by replacing the controller's
full Helm values with defaults.

---

## 3. Create a Dedicated Healthy Test Node

This pool isolates the exercise's workload. It does not isolate the
cluster-wide NodeRepair controller feature gate, which is why Step 2 is
sandbox-only.

```bash
kubectl apply -f k8s/karpenter/nodepool-repair-lab.yaml
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: repair-lab-check
  namespace: default
spec:
  nodeSelector:
    nodepool: repair-lab
  containers:
    - name: pause
      image: public.ecr.aws/eks-distro/kubernetes/pause:3.7
      resources:
        requests:
          cpu: 250m
          memory: 256Mi
EOF

kubectl wait --for=condition=Ready pod/repair-lab-check --timeout=5m
kubectl get pod repair-lab-check -o wide
kubectl get nodes -l nodepool=repair-lab
```

The dedicated NodePool allows one unhealthy disruption at a time. The node
should remain healthy throughout this lab; no fault is induced.

---

## 4. Inspect Node and NodeClaim Health

Use a healthy cluster to learn the signals that you would inspect during an
incident:

```bash
kubectl get nodes \
  -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,REASON:.status.conditions[?(@.type=="Ready")].reason,AGE:.metadata.creationTimestamp'
kubectl describe nodes
kubectl get nodeclaims
kubectl get events -A --sort-by=.lastTimestamp
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter --since=30m
```

For a node that is `NotReady`, examine its Conditions, Events, NodeClaim
conditions, underlying EC2 instance status, and application impact:

```bash
kubectl describe node <node-name>
kubectl describe nodeclaim <nodeclaim-name>
kubectl get pods -A -o wide --field-selector spec.nodeName=<node-name>
```

Repair can replace nodes only after a monitored condition exceeds its
version-specific toleration. Repair actions are rate limited by NodePool
disruption budgets using the `Unhealthy` reason. Correlated health failures
can cause repair to be blocked to avoid replacing many nodes when the
underlying cause is shared, such as a bad AMI or AZ issue.

---

## 5. Rehearse the Response Without Injecting a Failure

1. Record its NodeClaim, node, AZ, pods, and NodePool limits.
2. Review the controller's feature-gate setting and IAM policy.
3. Inspect the node and NodeClaim conditions and recent events.
4. Confirm the repair budget and PDBs before proceeding with any replacement.
5. Document the expected replacement and rollback or escalation path.

For a controlled exercise of voluntary replacement and PDB behavior, use the
AMI canary workflow in [Lab 11](./11-safe-node-and-cluster-upgrades.md).
That tests drift-based replacement, **not** Node Auto Repair. Do not use
`kubectl delete node`, terminate EC2 instances, or fabricate Node status to
simulate repair; these bypass or misrepresent the repair controller's
normal health detection and may strand workloads or volumes.

---

## 6. Disable the Feature and Clean Up

If NodeRepair was disabled before the lab, restore that prior state using
Helm's saved values and the same chart version. For the default settings in
this repository:

```bash
helm upgrade karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version 1.14.1 \
  --namespace karpenter \
  --reuse-values \
  --set settings.featureGates.nodeRepair=false \
  --wait
```

If the cluster had a different feature-gate configuration before the lab,
restore that configuration instead. Confirm the controller rollout and
effective settings after the change. Then remove the test workload and
NodePool:

```bash
kubectl delete pod repair-lab-check --ignore-not-found
kubectl delete -f k8s/karpenter/nodepool-repair-lab.yaml
```

---

## Production Takeaways

- Node Auto Repair is version- and feature-gate-dependent; verify the exact
  release and controller configuration first.
- A NodeRepair feature-gate change affects the cluster-wide controller, even
  when the workload NodePool is dedicated.
- Validate controller IAM permissions and NodePool `Unhealthy` budgets before
  relying on repair.
- Monitor node conditions, NodeClaim conditions, events, PDBs, and correlated
  failures; do not assume that a single unhealthy node proves an isolated
  instance fault.
- Use a staging environment for fault injection and follow official
  version-specific repair tolerations and safeguards.

**Related:** [Lab 09 — NodePool Disruption Budgets](./09-nodepool-disruption-budgets.md) ·
[Lab 11 — Safe Node and Cluster Upgrades](./11-safe-node-and-cluster-upgrades.md)
