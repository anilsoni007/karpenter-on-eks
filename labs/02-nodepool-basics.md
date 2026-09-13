# Lab 02 — NodePool & EC2NodeClass Basics

This lab explains the two core Karpenter CRDs and creates a baseline configuration that all subsequent labs build on.

---

## The Two CRDs You Must Understand

### EC2NodeClass
Answers: **How should the EC2 instance be configured?**
- Which AMI family (AL2, Bottlerocket, Windows)
- Which subnets (via tags)
- Which security groups (via tags)
- Which instance profile
- Block device mappings, user data

### NodePool
Answers: **What workloads can land here, and under what constraints?**
- Which instance types/families/sizes are allowed
- On-demand vs Spot
- CPU/memory limits (budget cap)
- Disruption policy (when to consolidate or expire nodes)
- Node labels and taints

**The relationship:** A NodePool references an EC2NodeClass. One EC2NodeClass can be shared by multiple NodePools.

---

## 1. Create the EC2NodeClass

```bash
# The YAML files have the cluster name hardcoded (soni-cluster).
# If you are using a different cluster, update the values in the YAML files
# under k8s/karpenter/ before applying.
kubectl apply -f k8s/karpenter/ec2nodeclass.yaml

# Verify the EC2NodeClass resolved subnets and security groups — should show Ready
kubectl get ec2nodeclass default
```

See `k8s/karpenter/ec2nodeclass.yaml` for the full manifest with inline comments.

**Key fields explained:**

`amiSelectorTerms` — Instead of hardcoding an AMI ID, Karpenter queries SSM for the latest EKS-optimized AMI matching your cluster version. This means nodes always launch with patched AMIs without any manual updates.

`subnetSelectorTerms` — Uses the `karpenter.sh/discovery` tag you applied in Lab 01. Karpenter will spread nodes across all matching subnets (and therefore AZs) automatically.

`securityGroupSelectorTerms` — Same tag-based discovery for security groups.

`instanceProfile` — The EC2 instance profile created in Lab 01. This is what gives the node its IAM identity to join the cluster.

---

## 2. Create the NodePools

```bash
kubectl apply -f k8s/karpenter/nodepool-general.yaml
kubectl apply -f k8s/karpenter/nodepool-t-family.yaml
kubectl apply -f k8s/karpenter/nodepool-graviton.yaml
kubectl apply -f k8s/karpenter/nodepool-spot-batch.yaml

kubectl get nodepool
```

**Key fields explained:**

`requirements` — These are node selector constraints. Karpenter only considers instance types that satisfy ALL requirements simultaneously.

- `karpenter.k8s.aws/instance-category: [c, m, r]` — compute, memory, and general purpose families. Excludes GPU, bare metal, etc.
- `karpenter.k8s.aws/instance-generation: ["5", "6", "7"]` — only recent generations. Older generations are often slower and more expensive per unit of compute.
- `kubernetes.io/arch: amd64` — x86 only for this pool. You'd create a separate NodePool for ARM/Graviton.
- `karpenter.sh/capacity-type: [on-demand, spot]` — allows both. Karpenter will prefer Spot when available.

`limits` — This is a **budget cap**, not a target. Karpenter will not provision nodes beyond this total CPU/memory. This prevents runaway scaling from a misconfigured HPA or a load test gone wrong.

`disruption.consolidationPolicy: WhenEmptyOrUnderutilized` — Karpenter will:
1. Immediately remove nodes with no pods (`WhenEmpty`)
2. Bin-pack underutilized nodes by moving pods to fewer, fuller nodes (`WhenUnderutilized`)

`disruption.consolidateAfter: 30s` — How long a node must be underutilized before Karpenter acts. In production you'd set this higher (e.g., `5m`) to avoid thrashing.

---

## 3. Verify the NodePool

```bash
kubectl get nodepool
kubectl describe nodepool general-purpose
```

The NodePool status shows current usage vs limits:

```
Status:
  Resources:
    Cpu:     0/100        ← 0 used out of 100 limit
    Memory:  0/400Gi
```

---

## 4. Understanding NodePool Weight

When multiple NodePools match a pod's requirements, Karpenter uses `weight` to prefer one over another. Higher weight = higher preference.

```yaml
spec:
  weight: 100   # prefer this pool over lower-weighted pools
```

This is useful when you want to prefer on-demand for critical workloads and spot for batch — you create two NodePools with different weights and capacity types.

---

## 5. Test Node Provisioning

Deploy a simple pause pod that requests more resources than your existing nodes have free:

```bash
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inflate
spec:
  replicas: 5
  selector:
    matchLabels:
      app: inflate
  template:
    metadata:
      labels:
        app: inflate
    spec:
      containers:
      - name: inflate
        image: public.ecr.aws/eks-distro/kubernetes/pause:3.7
        resources:
          requests:
            cpu: "1"
            memory: "1.5Gi"
EOF
```

**Watch Karpenter respond in real time:**

```bash
# Terminal 1 — watch pods
kubectl get pods -w

# Terminal 2 — watch nodes
kubectl get nodes -w

# Terminal 3 — watch Karpenter logs
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter -f
```

You'll see Karpenter log something like:
```
found provisionable pod(s)  count=5
computed new nodeclaim  instance-type=m5.xlarge
launched nodeclaim  provider-id=aws:///us-east-1a/i-0abc123
```

**Why does Karpenter pick that instance type?**  
Karpenter runs a bin-packing algorithm across all allowed instance types and picks the cheapest option that fits all pending pods. It considers the current Spot price if Spot is enabled.

---

## 6. Clean Up the Test

```bash
kubectl delete deployment inflate
```

Watch the node get removed after `consolidateAfter` seconds — Karpenter will detect the node is empty and terminate it.

---

## Key Concepts Recap

| Field | Why it matters |
|-------|---------------|
| `amiSelectorTerms` | Auto-tracks latest patched AMI — no manual AMI updates |
| `subnetSelectorTerms` | Tag-based — survives subnet changes without config updates |
| `requirements` | Constrains which EC2 types are eligible — prevents surprises |
| `limits` | Hard budget cap — prevents runaway scaling |
| `consolidationPolicy` | Controls cost optimization aggressiveness |
| `weight` | Tie-breaking between multiple NodePools |

**Next:** [Lab 03 — Deploy the ShopFront App](./03-deploy-app.md)
