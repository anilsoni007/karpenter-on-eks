# Lab 03 — Deploy the ShopFront Application

This lab builds and deploys the 3-tier ShopFront app. After this lab you'll have a running application you can use to drive all subsequent Karpenter experiments.

---

## Application Architecture

```
Internet
   │
   ▼
ALB (internet-facing)
   │
   ▼
frontend (Nginx, 2 replicas)
   │  proxies /api/* to
   ▼
backend-api (Node.js, 2 replicas)   ←── HPA watches CPU
   
worker (Python, 1 replica)          ←── runs on spot-batch NodePool
```

---

## 1. Create ECR Repositories

```bash
for repo in shopfront-frontend shopfront-backend shopfront-worker; do
  aws ecr create-repository \
    --repository-name $repo \
    --region $AWS_REGION \
    --image-scanning-configuration scanOnPush=true
done
```

**Why `scanOnPush=true`?**  
ECR will automatically scan images for known CVEs on every push. In production this is a baseline security requirement — you'd also add a policy to block deployments of images with critical vulnerabilities.

---

## 2. Build and Push Images

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin \
  ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

ECR_BASE=${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

# Frontend
docker build -t ${ECR_BASE}/shopfront-frontend:latest app/frontend/
docker push ${ECR_BASE}/shopfront-frontend:latest

# Backend
docker build -t ${ECR_BASE}/shopfront-backend:latest app/backend/
docker push ${ECR_BASE}/shopfront-backend:latest

# Worker
docker build -t ${ECR_BASE}/shopfront-worker:latest app/worker/
docker push ${ECR_BASE}/shopfront-worker:latest
```

---

## 3. Update Image References in Manifests

The manifests use placeholder `<AWS_ACCOUNT_ID>` and `<AWS_REGION>`. Replace them:

```bash
# On Linux/Mac
find k8s/app/ -name "*.yaml" -exec sed -i \
  "s|<AWS_ACCOUNT_ID>|${AWS_ACCOUNT_ID}|g; s|<AWS_REGION>|${AWS_REGION}|g" {} \;

# On Windows PowerShell
Get-ChildItem k8s\app\*.yaml | ForEach-Object {
  (Get-Content $_) -replace '<AWS_ACCOUNT_ID>', $env:AWS_ACCOUNT_ID `
                   -replace '<AWS_REGION>', $env:AWS_REGION | Set-Content $_
}
```

---

## 4. Deploy the Application

```bash
# Namespace first
kubectl apply -f k8s/app/00-namespace.yaml

# Core workloads
kubectl apply -f k8s/app/backend-deployment.yaml
kubectl apply -f k8s/app/frontend-deployment.yaml
kubectl apply -f k8s/app/worker-deployment.yaml

# Reliability resources
kubectl apply -f k8s/app/pdb.yaml
kubectl apply -f k8s/app/hpa.yaml

# Ingress (ALB)
kubectl apply -f k8s/ingress/shopfront-ingress.yaml
```

---

## 5. Watch Karpenter Provision Nodes

```bash
# Watch pods come up
kubectl get pods -n shopfront -w

# Watch Karpenter provision nodes for the new pods
kubectl get nodes -L karpenter.sh/nodepool,karpenter.sh/capacity-type -w

# Watch Karpenter logs
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter -f
```

**What you'll observe:**  
If your existing nodes don't have enough free capacity, Karpenter will detect the pending pods and provision new nodes within ~30-60 seconds. Watch the logs — you'll see Karpenter evaluate instance types, pick the cheapest fit, and call EC2 RunInstances.

---

## 6. Get the ALB URL

```bash
kubectl get ingress shopfront -n shopfront
```

Wait for the `ADDRESS` field to populate (takes ~2 minutes for ALB provisioning). Then open the URL in your browser.

```bash
ALB_URL=$(kubectl get ingress shopfront -n shopfront \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
echo "http://${ALB_URL}"
```

---

## 7. Verify the Application

```bash
# Health check
curl http://${ALB_URL}/api/health

# Products endpoint
curl http://${ALB_URL}/api/products

# Node info — shows which pod/node served the request
curl http://${ALB_URL}/api/nodeinfo
```

Call `/api/nodeinfo` multiple times — you'll see different pod names as the ALB load-balances across replicas.

---

## 8. Understand the PodDisruptionBudget

```bash
kubectl get pdb -n shopfront
```

The PDB ensures that during Karpenter consolidation, at least 1 backend pod and 1 frontend pod remain available. Without PDBs, Karpenter could evict all pods simultaneously while bin-packing, causing a brief outage.

**Test it:**
```bash
# Try to evict all backend pods at once — the PDB will block the second eviction
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

You'll see the drain pause waiting for the PDB constraint to be satisfied.

---

## 9. Verify Worker on Spot

```bash
kubectl get pods -n shopfront -l app=worker -o wide
kubectl get node <worker-node-name> -L karpenter.sh/capacity-type
```

The worker should be on a node with `karpenter.sh/capacity-type=spot` from the `spot-batch` NodePool.

**Why does this work?**  
The worker Deployment has:
1. A `toleration` for the `workload-type=batch:NoSchedule` taint
2. A `nodeSelector` for `nodepool=spot-batch`

Without both, the pod would either not tolerate the taint (and be rejected) or land on the wrong pool.

---

## Summary

You now have:
- Frontend (Nginx) — 2 replicas, low resource requests, good for bin-packing
- Backend API (Node.js) — 2 replicas, HPA-enabled, CPU load endpoint for scaling tests
- Worker (Python) — 1 replica on Spot, graceful SIGTERM handling for interruption tests
- ALB Ingress — internet-facing, IP target mode
- PDBs — prevent consolidation-induced downtime

**Next:** [Lab 04 — Scaling Lab](./04-scaling-lab.md)
