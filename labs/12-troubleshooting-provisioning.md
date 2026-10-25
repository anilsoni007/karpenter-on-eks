# Lab 12 — Troubleshooting Failed Provisioning

This lab reproduces a common Karpenter failure safely: a pod's scheduling
requirements do not overlap with its target NodePool. You will trace the issue
from Pending pod to NodePool constraints, correct the pod, and inspect
additional production failure signals.

---

## 1. Create a Dedicated Troubleshooting NodePool

```bash
kubectl apply -f k8s/karpenter/nodepool-troubleshooting-lab.yaml
kubectl get nodepool troubleshooting-lab -o yaml
```

This pool allows AMD64 On-Demand instances only. It has a unique node label and
a small CPU/memory cap so the test workload cannot land on the shared
`general-purpose` pool.

---

## 2. Reproduce an Unsatisfiable Scheduling Request

Create a pod that targets this pool but requests ARM64:

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: provisioning-debug
  namespace: default
spec:
  nodeSelector:
    nodepool: troubleshooting-lab
    kubernetes.io/arch: arm64
  containers:
    - name: pause
      image: public.ecr.aws/eks-distro/kubernetes/pause:3.7
      resources:
        requests:
          cpu: 250m
          memory: 256Mi
EOF
```

The pod should stay Pending. Inspect the scheduler events, the NodePool
requirements, and Karpenter's recent logs:

```bash
kubectl describe pod provisioning-debug
kubectl get nodepool troubleshooting-lab -o yaml
kubectl get nodeclaims
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter --since=10m
```

The NodePool permits only `kubernetes.io/arch=amd64`, while the pod requires
`arm64`. No instance type satisfies both constraints, so Karpenter cannot
create a NodeClaim for this pod. Because the pod also targets a unique pool
label, other NodePools cannot satisfy it either.

---

## 3. Correct the Workload Requirement

Replace the pod with a corrected manifest. Deleting and recreating the pod
avoids relying on whether the Kubernetes version allows changing scheduling
fields on an already-created pod:

```bash
kubectl delete pod provisioning-debug
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: provisioning-debug
  namespace: default
spec:
  nodeSelector:
    nodepool: troubleshooting-lab
    kubernetes.io/arch: amd64
  containers:
    - name: pause
      image: public.ecr.aws/eks-distro/kubernetes/pause:3.7
      resources:
        requests:
          cpu: 250m
          memory: 256Mi
EOF
```

Watch the corrected pod and NodeClaim:

```bash
kubectl get pod provisioning-debug -w
kubectl get nodeclaims -w
kubectl get nodes -l nodepool=troubleshooting-lab
```

---

## 4. Production Triage Checklist

When a pod remains Pending, investigate in this order:

1. **Pod events and scheduling constraints**
   ```bash
   kubectl describe pod <pod> -n <namespace>
   kubectl get pod <pod> -n <namespace> -o yaml
   ```
   Check resource requests, selectors, affinity, topology spread, taints and
   tolerations, PVC zone constraints, and pod-level limits.
2. **NodePool and EC2NodeClass readiness**
   ```bash
   kubectl get nodepool
   kubectl describe nodepool <pool>
   kubectl get ec2nodeclass
   kubectl describe ec2nodeclass <class>
   ```
   Check requirement intersection, NodePool limits, `Ready` conditions,
   discovered subnets/security groups, and the referenced instance profile.
3. **NodeClaims and controller logs**
   ```bash
   kubectl get nodeclaims
   kubectl describe nodeclaim <nodeclaim>
   kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter --since=15m
   ```
   No NodeClaim can indicate unsatisfied scheduling constraints. A NodeClaim
   that fails to initialize points to launch capacity, IAM, bootstrap, network,
   or node-join problems.
4. **AWS-side limits and networking**
   ```bash
   aws service-quotas list-service-quotas --service-code ec2 --region "$AWS_REGION"
   aws ec2 describe-subnets \
     --filters "Name=tag:karpenter.sh/discovery,Values=${CLUSTER_NAME}" \
     --query 'Subnets[*].{Id:SubnetId,AZ:AvailabilityZone,FreeIPs:AvailableIpAddressCount}'
   ```
   Check relevant vCPU quotas, subnet free IPs, AZ instance offerings, EC2
   capacity, and controller IAM errors before broadening NodePool constraints.

Avoid responding to a Pending pod by blindly increasing NodePool limits or
loosening every requirement. Identify the exact unsatisfied constraint first.

---

## 5. Clean Up

```bash
kubectl delete pod provisioning-debug --ignore-not-found
kubectl delete -f k8s/karpenter/nodepool-troubleshooting-lab.yaml
```

---

## Production Takeaways

- Start from the pod's scheduler events and trace each constraint to its
  NodePool, NodeClass, storage, or AWS capacity source.
- A NodeClaim proves Karpenter found a feasible launch request; inspect its
  conditions to diagnose failures after that point.
- Keep NodePool constraints intentional and capacity limits bounded.
- Check subnet IPs, quotas, and AZ offerings as well as Kubernetes objects.

**Related:** [Lab 02 — NodePool Basics](./02-nodepool-basics.md) ·
[Lab 08 — Production Best Practices](./08-production-best-practices.md)
