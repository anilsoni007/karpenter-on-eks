# Lab 08 — Production Best Practices

This lab consolidates everything into a production-ready checklist and covers operational patterns you'll need when running Karpenter at scale.

---

## 1. Karpenter High Availability

Karpenter itself must be highly available — if it goes down, no new nodes can be provisioned.

```bash
# Verify Karpenter runs on On-Demand nodes, not Spot
# (You don't want Karpenter to be interrupted while provisioning nodes)
kubectl get pods -n karpenter -o wide
kubectl get node <karpenter-node> -L karpenter.sh/capacity-type
```

Karpenter should run on your existing managed node group (On-Demand). If it's running on a Karpenter-managed Spot node, add a node affinity to the Karpenter deployment:

```bash
kubectl patch deployment karpenter -n karpenter --type=merge -p '
{
  "spec": {
    "template": {
      "spec": {
        "affinity": {
          "nodeAffinity": {
            "requiredDuringSchedulingIgnoredDuringExecution": {
              "nodeSelectorTerms": [{
                "matchExpressions": [{
                  "key": "eks.amazonaws.com/nodegroup",
                  "operator": "Exists"
                }]
              }]
            }
          }
        }
      }
    }
  }
}'
```

**Why?**  
If Karpenter runs on a Spot node and that node is interrupted, Karpenter goes down. During the time it takes to reschedule Karpenter, any pods that need new nodes will remain Pending. For a production cluster, this is unacceptable.

---

## 2. NodePool Limits — Right-Sizing Your Budget Cap

```bash
# Check current NodePool utilization vs limits
kubectl get nodepool -o custom-columns=\
"NAME:.metadata.name,\
CPU-USED:.status.resources.cpu,\
MEM-USED:.status.resources.memory"
```

**Guidelines for setting limits:**
- Set limits to 2-3x your expected peak load, not your average load
- Too low: pods stay Pending during traffic spikes
- Too high: a misconfigured HPA or load test can run up a large bill

```bash
# Alert when a NodePool reaches 80% of its limit
# Add this to your monitoring system (CloudWatch, Datadog, etc.)
# Metric: karpenter_nodepools_usage / karpenter_nodepools_limit > 0.8
```

---

## 3. Monitoring Karpenter with CloudWatch

Karpenter exposes Prometheus metrics. Scrape them and forward to CloudWatch:

```bash
# Key metrics to monitor (Karpenter 1.x metric names):
# karpenter_nodes_total                          — total nodes managed
# karpenter_pods_state                           — pods by state (pending, running)
# karpenter_nodeclaims_total                     — node provisioning activity
# karpenter_disruption_decisions_total           — consolidation/drift decisions made
# karpenter_disruption_actions_performed_total   — consolidation/drift actions executed
# karpenter_interruption_received_messages_total — spot interruptions received
```

**Critical alerts to set up:**

| Alert | Condition | Severity |
|-------|-----------|----------|
| Pods stuck Pending | `karpenter_pods_state{state="pending"} > 0` for > 5min | High |
| NodePool near limit | usage/limit > 0.85 | Medium |
| Karpenter pod down | `up{job="karpenter"} == 0` | Critical |
| High interruption rate | `rate(karpenter_interruption_received_messages_total[5m]) > 5` | Medium |

---

## 4. IAM Least Privilege Audit

```bash
# Review what permissions Karpenter's role has
aws iam get-role-policy \
  --role-name KarpenterControllerRole-${CLUSTER_NAME} \
  --policy-name KarpenterControllerPolicy-${CLUSTER_NAME}
```

**Production hardening:**
- Scope `ec2:RunInstances` to specific subnets and security groups using resource conditions
- Scope `iam:PassRole` to only the KarpenterNodeRole
- Enable CloudTrail logging for all Karpenter IAM actions
- Use AWS Config rules to detect policy drift

---

## 5. AMI Management and Node Expiry

```bash
# Check when nodes were created (to understand expiry timing)
kubectl get nodes -o custom-columns=\
"NAME:.metadata.name,\
CREATED:.metadata.creationTimestamp,\
NODEPOOL:.metadata.labels.karpenter\.sh/nodepool"
```

**AMI rotation strategy:**
- `expireAfter: 720h` (30 days) is a good default
- Nodes are replaced one at a time, respecting PDBs
- New nodes get the latest AMI from SSM automatically
- No manual AMI ID updates needed

**Testing AMI rotation:**
```bash
# Force immediate expiry of all nodes in a NodePool (use with caution)
kubectl annotate nodeclaim <nodeclaim-name> \
  karpenter.sh/do-not-disrupt-  # remove do-not-disrupt if set

# Manually trigger drift by updating the NodePool
kubectl patch nodepool general-purpose --type=merge -p \
  '{"spec":{"template":{"metadata":{"annotations":{"rotation-trigger":"'$(date +%s)'"}}}}}'
```

---

## 6. Multi-Region and Multi-Cluster Considerations

**Subnet tagging in multi-cluster environments:**  
If multiple EKS clusters share a VPC, each cluster's Karpenter must only use its own subnets. The `karpenter.sh/discovery` tag value is the cluster name — ensure subnets are tagged with the correct cluster name.

```bash
# Verify subnet tags are cluster-specific
aws ec2 describe-subnets \
  --filters "Name=tag:karpenter.sh/discovery,Values=${CLUSTER_NAME}" \
  --query "Subnets[*].{ID:SubnetId,AZ:AvailabilityZone,CIDR:CidrBlock}"
```

---

## 7. Graceful Cluster Upgrades

When upgrading EKS, Karpenter-managed nodes need to be replaced with nodes running the new Kubernetes version.

```bash
# Step 1: Upgrade the EKS control plane first (via console or eksctl)

# Step 2: Update the EC2NodeClass to use the new AMI alias
# (al2023@latest automatically resolves to the new version's AMI)

# Step 3: Trigger rolling replacement by updating NodePool annotation
kubectl patch nodepool general-purpose --type=merge -p \
  '{"spec":{"template":{"metadata":{"annotations":{"upgrade-trigger":"'$(date +%s)'"}}}}}'

# Step 4: Watch rolling replacement
kubectl get nodes -w
```

Karpenter replaces nodes one at a time, respecting PDBs. Your application stays available throughout the upgrade.

---

## 8. Cost Optimization Checklist

```bash
# 1. Check Spot vs On-Demand ratio
kubectl get nodes -L karpenter.sh/capacity-type | \
  awk 'NR>1 {print $NF}' | sort | uniq -c

# 2. Check for oversized nodes (low utilization)
kubectl top nodes

# 3. Check for pods with no resource requests (Karpenter can't bin-pack these)
kubectl get pods -A -o json | \
  jq '.items[] | select(.spec.containers[].resources.requests == null) | .metadata.name'

# 4. Check NodePool limits vs actual usage
kubectl describe nodepool | grep -A5 "Resources:"
```

**The most impactful cost optimizations:**
1. Set accurate resource requests on all pods (enables bin-packing)
2. Use Spot for stateless/batch workloads (60-80% savings)
3. Use Graviton for compatible workloads (20-40% savings)
4. Set `consolidateAfter` appropriately (don't set it too high)
5. Use `expireAfter` to rotate nodes and avoid zombie instances

---

## 9. Operational Runbook — Common Issues

### Pods stuck in Pending

```bash
# Check why pods are pending
kubectl describe pod <pending-pod> -n shopfront | grep -A10 Events

# Check if NodePool limit is hit
kubectl describe nodepool general-purpose | grep -A5 "Status:"

# Check Karpenter logs for errors
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter | grep -i "error\|failed"
```

Common causes:
- NodePool limit reached → increase limits or reduce replicas
- No subnets with `karpenter.sh/discovery` tag → re-tag subnets
- IAM permission error → check IRSA setup
- Pod has unsatisfiable requirements → check nodeSelector/affinity

### Nodes not consolidating

```bash
# Check what's blocking consolidation
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter | grep -i "cannot\|block\|pdb"
```

Common causes:
- PDB blocking eviction → expected behavior, wait for more replicas
- `do-not-disrupt` annotation on pod → intentional, remove if needed
- Pod with local storage → cannot be moved, expected
- `consolidationPolicy: WhenEmpty` → change to `WhenEmptyOrUnderutilized`

### Node not joining cluster

```bash
# Check if aws-auth has the node role
kubectl get configmap aws-auth -n kube-system -o yaml | grep KarpenterNodeRole

# Check EC2 instance system logs
aws ec2 get-console-output --instance-id <instance-id> --output text | tail -50
```

---

## Production Readiness Checklist

- [ ] Karpenter runs on On-Demand managed node group
- [ ] Karpenter has 2+ replicas with PDB
- [ ] All NodePools have appropriate `limits`
- [ ] All NodePools have `expireAfter` set (AMI rotation)
- [ ] SQS interruption queue configured and EventBridge rules active
- [ ] All application pods have resource `requests` set
- [ ] PDBs configured for all critical services
- [ ] Pods have SIGTERM handlers and appropriate `terminationGracePeriodSeconds`
- [ ] CloudWatch alerts for Pending pods and NodePool limits
- [ ] Subnet and security group tags are cluster-specific
- [ ] Node root volumes are encrypted
- [ ] ECR image scanning enabled
- [ ] IAM roles follow least privilege

---

## Congratulations

You've completed the full Karpenter hands-on lab. You now understand:

- How Karpenter provisions nodes in response to pending pods
- How to design NodePools for different workload classes
- How Spot interruption handling works end-to-end
- How consolidation reduces costs automatically
- Advanced scheduling patterns for production workloads
- Operational practices for running Karpenter at scale
