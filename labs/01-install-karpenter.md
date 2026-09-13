# Lab 01 — Install Karpenter

This lab walks through creating the IAM role, instance profile, and deploying Karpenter via Helm onto your existing EKS cluster.

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  EKS Control Plane                          │
│                                             │
│  karpenter (namespace)                      │
│  └── karpenter-controller (Pod)             │
│       └── IRSA → KarpenterControllerRole    │
│            └── EC2, SQS, SSM permissions    │
└─────────────────────────────────────────────┘
         │ watches unschedulable pods
         │ calls EC2 RunInstances
         ▼
┌─────────────────────────────────────────────┐
│  New EC2 Node                               │
│  └── KarpenterInstanceProfile               │
│       └── KarpenterNodeRole                 │
│            └── joins cluster via bootstrap  │
└─────────────────────────────────────────────┘
```

Two IAM roles are involved:
- **KarpenterControllerRole** — assumed by the Karpenter pod (via IRSA) to call EC2/SQS/SSM APIs
- **KarpenterNodeRole** — assumed by EC2 instances Karpenter launches, so they can join the cluster

---

## 1. Create the Karpenter Node IAM Role

This role is attached to every EC2 instance Karpenter launches. It needs the same policies as any EKS worker node.

```bash
cat > /tmp/node-trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ec2.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

aws iam create-role \
  --role-name KarpenterNodeRole-${CLUSTER_NAME} \
  --assume-role-policy-document file:///tmp/node-trust-policy.json

# These four policies are the minimum for an EKS worker node
for policy in \
  AmazonEKSWorkerNodePolicy \
  AmazonEKS_CNI_Policy \
  AmazonEC2ContainerRegistryReadOnly \
  AmazonSSMManagedInstanceCore; do
  aws iam attach-role-policy \
    --role-name KarpenterNodeRole-${CLUSTER_NAME} \
    --policy-arn arn:aws:iam::aws:policy/${policy}
done
```

**Why `AmazonSSMManagedInstanceCore`?**  
Karpenter uses SSM Parameter Store to resolve the latest EKS-optimized AMI IDs dynamically. Without this, nodes can't look up the correct AMI for your cluster version.

---

## 2. Create the EC2 Instance Profile

An instance profile is the container that attaches an IAM role to an EC2 instance. The role alone is not enough — EC2 requires an instance profile.

```bash
aws iam create-instance-profile \
  --instance-profile-name KarpenterNodeInstanceProfile-${CLUSTER_NAME}

aws iam add-role-to-instance-profile \
  --instance-profile-name KarpenterNodeInstanceProfile-${CLUSTER_NAME} \
  --role-name KarpenterNodeRole-${CLUSTER_NAME}
```

---

## 3. Create the Karpenter Controller IAM Policy

This policy grants the Karpenter controller pod the permissions it needs to manage EC2 instances on your behalf.

```bash
cat > /tmp/controller-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowEC2Actions",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateLaunchTemplate",
        "ec2:CreateFleet",
        "ec2:RunInstances",
        "ec2:CreateTags",
        "ec2:TerminateInstances",
        "ec2:DeleteLaunchTemplate",
        "ec2:DescribeLaunchTemplates",
        "ec2:DescribeInstances",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeSpotPriceHistory",
        "ec2:DescribeImages"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AllowEKSDescribeCluster",
      "Effect": "Allow",
      "Action": "eks:DescribeCluster",
      "Resource": "arn:aws:eks:${AWS_REGION}:${AWS_ACCOUNT_ID}:cluster/${CLUSTER_NAME}"
      // WHY: Added in Karpenter 1.x — controller calls eks:DescribeCluster at startup
      // to resolve the cluster endpoint dynamically instead of requiring it as a Helm value.
      // Without this you get: AccessDeniedException: not authorized to perform: eks:DescribeCluster
      // FIX (if already installed): aws iam put-role-policy \
      //   --role-name KarpenterControllerRole-${CLUSTER_NAME} \
      //   --policy-name KarpenterEKSFix \
      //   --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"eks:DescribeCluster","Resource":"arn:aws:eks:${AWS_REGION}:${AWS_ACCOUNT_ID}:cluster/${CLUSTER_NAME}"}]}'
    },
    {
      "Sid": "AllowIAMInstanceProfiles",
      "Effect": "Allow",
      "Action": [
        "iam:ListInstanceProfiles",
        "iam:CreateInstanceProfile",
        "iam:DeleteInstanceProfile",
        "iam:GetInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:RemoveRoleFromInstanceProfile",
        "iam:TagInstanceProfile"
      ],
      "Resource": "arn:aws:iam::${AWS_ACCOUNT_ID}:instance-profile/*"
      // WHY: Karpenter 1.x manages instance profiles itself (create/delete/tag) as part of
      // its instanceprofile.garbagecollection controller. In v0.x you created the instance
      // profile manually (Step 2 above) and Karpenter never touched IAM directly.
      // Without this you get: AccessDenied: not authorized to perform: iam:ListInstanceProfiles
      // FIX (if already installed): aws iam put-role-policy \
      //   --role-name KarpenterControllerRole-${CLUSTER_NAME} \
      //   --policy-name KarpenterIAMFix \
      //   --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["iam:ListInstanceProfiles","iam:CreateInstanceProfile","iam:DeleteInstanceProfile","iam:GetInstanceProfile","iam:AddRoleToInstanceProfile","iam:RemoveRoleFromInstanceProfile","iam:TagInstanceProfile"],"Resource":"arn:aws:iam::${AWS_ACCOUNT_ID}:instance-profile/*"}]}'
    },
    {
      "Sid": "AllowSSMGetParameter",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:*:*:parameter/aws/service/*"
    },
    {
      "Sid": "AllowPassRoleToEC2",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/KarpenterNodeRole-${CLUSTER_NAME}"
    },
    {
      "Sid": "AllowSQSForInterruption",
      "Effect": "Allow",
      "Action": [
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:ReceiveMessage"
      ],
      "Resource": "arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:Karpenter-${CLUSTER_NAME}"
    },
    {
      "Sid": "AllowPricingAPI",
      "Effect": "Allow",
      "Action": "pricing:GetProducts",
      "Resource": "*"
      // WHY: Karpenter uses this to fetch real-time Spot prices and sort instance types
      // by cost. The Pricing API is global and only reachable via us-east-1 endpoint.
      // COMMON FAILURE: Enterprise AWS accounts often have an SCP (Service Control Policy)
      // that blocks API calls outside approved regions. When blocked by SCP, adding this
      // permission to the role does NOT help — SCPs override identity-based policies.
      // You'll see: AccessDeniedException: no service control policy allows pricing:GetProducts
      // FIX: Add isolatedVPC=true to Helm (see Step 7). This disables the pricing API call
      // entirely. Karpenter still launches Spot/On-Demand correctly, just without
      // cross-instance-type price sorting.
      // helm upgrade karpenter oci://public.ecr.aws/karpenter/karpenter \
      //   --version 1.14.1 --namespace karpenter --reuse-values \
      //   --set settings.isolatedVPC=true
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name KarpenterControllerPolicy-${CLUSTER_NAME} \
  --policy-document file:///tmp/controller-policy.json
```

> **Note — `pricing:GetProducts` and SCPs:** The Pricing API endpoint is global (`us-east-1` only) and is commonly blocked by AWS Organizations Service Control Policies (SCPs) in enterprise accounts. If your account has an SCP that restricts API calls to specific regions, this permission will be denied even if it's in the role policy. The fix is to add `isolatedVPC=true` to the Helm install (see Step 7), which disables the pricing API call and makes Karpenter skip price-based instance sorting. Spot instances will still be launched — just without cross-instance-type price comparison.

**Why the SQS permission?**  
Karpenter watches an SQS queue for EC2 interruption notices (Spot interruptions, scheduled maintenance, rebalance recommendations). This is how it gracefully drains nodes before they disappear. We'll set up this queue in Lab 05.

---

## 4. Create the Karpenter Controller IAM Role (IRSA)

```bash
# Extract just the OIDC ID (last path segment)
OIDC_ID=$(echo $OIDC_ENDPOINT | cut -d'/' -f5)

cat > /tmp/controller-trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/oidc.eks.${AWS_REGION}.amazonaws.com/id/${OIDC_ID}"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "oidc.eks.${AWS_REGION}.amazonaws.com/id/${OIDC_ID}:sub": "system:serviceaccount:karpenter:karpenter",
        "oidc.eks.${AWS_REGION}.amazonaws.com/id/${OIDC_ID}:aud": "sts.amazonaws.com"
      }
    }
  }]
}
EOF

aws iam create-role \
  --role-name KarpenterControllerRole-${CLUSTER_NAME} \
  --assume-role-policy-document file:///tmp/controller-trust-policy.json

aws iam attach-role-policy \
  --role-name KarpenterControllerRole-${CLUSTER_NAME} \
  --policy-arn arn:aws:iam::${AWS_ACCOUNT_ID}:policy/KarpenterControllerPolicy-${CLUSTER_NAME}
```

**Why the `StringEquals` condition?**  
This scopes the trust to only the `karpenter` ServiceAccount in the `karpenter` namespace. Without this condition, any pod in the cluster could assume this powerful role.

---

## 5. Tag Subnets and Security Groups

Karpenter discovers which subnets and security groups to use by looking for specific tags. It does **not** use launch templates or node group configurations.

```bash
# Get the VPC used by the cluster
CLUSTER_VPC=$(aws eks describe-cluster \
  --name $CLUSTER_NAME \
  --query "cluster.resourcesVpcConfig.vpcId" \
  --output text)

# Try to find subnets tagged with the cluster name first (eksctl/managed node group clusters)
SUBNET_IDS=$(aws ec2 describe-subnets \
  --filters "Name=tag:kubernetes.io/cluster/${CLUSTER_NAME},Values=shared,owned" \
  --query "Subnets[*].SubnetId" --output text)

# Fallback: if no tagged subnets found, use all subnets in the cluster VPC
if [ -z "$SUBNET_IDS" ]; then
  echo "No cluster-tagged subnets found — falling back to all subnets in VPC ${CLUSTER_VPC}"
  SUBNET_IDS=$(aws ec2 describe-subnets \
    --filters "Name=vpc-id,Values=${CLUSTER_VPC}" \
    --query "Subnets[*].SubnetId" --output text)
fi

# Tag subnets — Karpenter will launch nodes into subnets with this tag
for SUBNET_ID in $SUBNET_IDS; do
  aws ec2 create-tags \
    --resources $SUBNET_ID \
    --tags Key=karpenter.sh/discovery,Value=${CLUSTER_NAME}
done
echo "Tagged subnets: $SUBNET_IDS"

# Tag the cluster security group
CLUSTER_SG=$(aws eks describe-cluster \
  --name $CLUSTER_NAME \
  --query "cluster.resourcesVpcConfig.clusterSecurityGroupId" \
  --output text)

aws ec2 create-tags \
  --resources $CLUSTER_SG \
  --tags Key=karpenter.sh/discovery,Value=${CLUSTER_NAME}
echo "Tagged security group: $CLUSTER_SG"
```

> **Note — Fallback behaviour:** If your subnets have no `kubernetes.io/cluster/` tags (common with manually created clusters or imported VPCs), the script automatically falls back to tagging every subnet in the cluster's VPC. Review the output and remove the tag from any subnets you don't want Karpenter to use.

**Why tag-based discovery?**  
This decouples Karpenter from hardcoded resource IDs. When you add new subnets or rotate security groups, you just apply the tag — no Karpenter config change needed.

---

## 6. Update aws-auth ConfigMap

Karpenter-launched nodes need to be allowed to join the cluster. This is done by adding the node role to the `aws-auth` ConfigMap.

```bash
kubectl edit configmap aws-auth -n kube-system
```

Add this entry under `mapRoles`:

```yaml
- rolearn: arn:aws:iam::<AWS_ACCOUNT_ID>:role/KarpenterNodeRole-<CLUSTER_NAME>
  username: system:node:{{EC2PrivateDNSName}}
  groups:
    - system:bootstrappers
    - system:nodes
```

**Why `{{EC2PrivateDNSName}}`?**  
This is a template variable that the node bootstrap script fills in with the actual hostname. Each node gets a unique username derived from its DNS name, which is required for the Kubernetes node authorization model.

---

## 7. Install Karpenter via Helm

```bash
export KARPENTER_VERSION=1.14.1

helm registry logout public.ecr.aws || true

# NOTE: isolatedVPC=true disables the pricing:GetProducts API call.
# This is needed when an AWS Organizations SCP blocks the Pricing API (common in
# enterprise/training accounts). Without it you get:
#   AccessDeniedException: no service control policy allows pricing:GetProducts
# Karpenter still launches Spot/On-Demand correctly — just without price-based sorting.
# Remove this flag if your account allows the Pricing API.
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version ${KARPENTER_VERSION} \
  --namespace karpenter \
  --create-namespace \
  --set settings.clusterName=${CLUSTER_NAME} \
  --set settings.interruptionQueue=Karpenter-${CLUSTER_NAME} \
  --set settings.isolatedVPC=true \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --set controller.resources.limits.cpu=1 \
  --set controller.resources.limits.memory=1Gi \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::${AWS_ACCOUNT_ID}:role/KarpenterControllerRole-${CLUSTER_NAME} \
  --wait
```

> **Note — `isolatedVPC=true`:** This disables the `pricing:GetProducts` API call, which is commonly blocked by AWS Organizations SCPs in enterprise/training accounts. Karpenter will still launch Spot and On-Demand instances correctly — it just won't sort instance types by real-time Spot price. Remove this flag if your account allows the Pricing API.

> **Note — 1.x settings:** In Karpenter 1.x the `karpenter-global-settings` ConfigMap was removed. All settings (`clusterName`, `interruptionQueue`, etc.) are now passed directly as Helm values and stored as environment variables on the controller Deployment. The `--set settings.*` flags above map to those env vars.

**Why `--wait`?**  
Helm will block until the Karpenter deployment is fully ready. This prevents you from moving to the next step before the controller is actually running.

---

## 8. Verify Installation

```bash
kubectl get pods -n karpenter
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter --tail=50
```

Look for: `controller.Started` in the logs. Any IAM errors here mean the IRSA setup in steps 3–4 needs revisiting.

```bash
# Confirm CRDs are installed
kubectl get crd | grep karpenter
```

You should see:
- `nodepools.karpenter.sh`
- `nodeclaims.karpenter.sh`
- `ec2nodeclasses.karpenter.k8s.aws`

---

## Key Concepts Recap

| Concept | What it does |
|---------|-------------|
| `EC2NodeClass` | Defines *how* to launch an instance (AMI, subnets, SGs, instance profile) |
| `NodePool` | Defines *what* workloads can land on Karpenter nodes (instance types, limits, disruption) |
| `NodeClaim` | Internal object Karpenter creates when it decides to provision a node |

**Next:** [Lab 02 — NodePool & EC2NodeClass Basics](./02-nodepool-basics.md)
