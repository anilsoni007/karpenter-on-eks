# Lab 00 — Prerequisites & Cluster Validation

Before installing Karpenter, validate your cluster is ready and collect values that every subsequent lab depends on.

---

## Why This Matters

Karpenter needs specific IAM permissions, OIDC federation, and cluster metadata to function. Getting these values wrong is the #1 cause of failed Karpenter installations. This lab ensures you have everything correct before touching the cluster.

---

## 1. Collect Cluster Metadata

These four values are referenced throughout every lab. Export them now and keep this terminal session open.

```bash
export CLUSTER_NAME=<your-cluster-name>
export AWS_REGION=<your-region>
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export OIDC_ENDPOINT=$(aws eks describe-cluster \
  --name $CLUSTER_NAME \
  --query "cluster.identity.oidc.issuer" \
  --output text)

echo "Cluster   : $CLUSTER_NAME"
echo "Region    : $AWS_REGION"
echo "Account   : $AWS_ACCOUNT_ID"
echo "OIDC      : $OIDC_ENDPOINT"
```

**Why `OIDC_ENDPOINT`?**  
Karpenter's controller pod uses IAM Roles for Service Accounts (IRSA). IRSA works by federating the cluster's OIDC provider with AWS IAM so the pod can assume an IAM role without static credentials. Every EC2 launch, termination, and describe call Karpenter makes goes through this role.

---

## 2. Verify OIDC Provider Exists in IAM

```bash
aws iam list-open-id-connect-providers | grep $(echo $OIDC_ENDPOINT | cut -d'/' -f5)
```

If this returns nothing, create the OIDC provider:

```bash
eksctl utils associate-iam-oidc-provider \
  --cluster $CLUSTER_NAME \
  --region $AWS_REGION \
  --approve
```

**Why?**  
Without the OIDC provider registered in IAM, the trust policy on Karpenter's IAM role won't resolve and the controller will fail to call EC2 APIs — it will silently fail to provision nodes.

---

## 3. Verify ALB Ingress Controller

```bash
kubectl get deployment -n kube-system aws-load-balancer-controller
```

Expected: `READY 2/2`. The ALB controller is needed in Lab 03 when we expose the ShopFront frontend via an Ingress resource.

---

## 4. Verify EBS StorageClass

```bash
kubectl get storageclass ebs-sc
kubectl describe storageclass ebs-sc
```

Confirm:
- `Provisioner` → `ebs.csi.aws.com`
- `VolumeBindingMode` → `WaitForFirstConsumer`

**Why `WaitForFirstConsumer`?**  
EBS volumes are AZ-specific. If a PVC is provisioned before the pod is scheduled, the volume might land in a different AZ than the node Karpenter provisions. `WaitForFirstConsumer` delays volume creation until the pod is placed, so Karpenter and EBS always agree on the AZ.

---

## 5. Check Existing Nodes

```bash
kubectl get nodes -L karpenter.sh/nodepool,eks.amazonaws.com/nodegroup
```

Karpenter adds new nodes **alongside** your existing node groups — it does not replace them. Your existing node groups should continue to handle system-critical pods (CoreDNS, kube-proxy, ALB controller, Karpenter itself).

---

## 6. Check Taints on System Nodes

```bash
kubectl describe nodes | grep -A5 Taints
```

**Why?**  
In Lab 02 you'll configure Karpenter NodePools to avoid co-scheduling Karpenter-managed nodes with system workloads. Understanding existing taints helps you design the right NodePool selectors and avoid accidental eviction of system pods.

---

## Summary Checklist

- [ ] `CLUSTER_NAME`, `AWS_REGION`, `AWS_ACCOUNT_ID`, `OIDC_ENDPOINT` exported
- [ ] OIDC provider exists in IAM
- [ ] ALB Ingress Controller running
- [ ] `ebs-sc` StorageClass with `WaitForFirstConsumer`
- [ ] Existing nodes visible
- [ ] Helm v3 available (`helm version`)

**Next:** [Lab 01 — Install Karpenter](./01-install-karpenter.md)
