# Lab 11 — Safe Node AMI and EKS Upgrade Rollouts

This lab uses a dedicated canary EC2NodeClass and NodePool to practice
Karpenter drift-based node replacement without changing the shared
`general-purpose` pool or the default EC2NodeClass.

> This is a node AMI canary exercise, not an EKS control-plane upgrade. Perform
> real control-plane and Karpenter controller upgrades through your normal
> staged change process after reviewing the compatibility guidance for the
> exact versions involved.

---

## 1. Preflight the Upgrade

Record current versions and check cluster health before making changes:

```bash
aws eks describe-cluster --name "$CLUSTER_NAME" \
  --query 'cluster.{version:version,status:status}' --output table
kubectl get nodes
kubectl get nodepool
kubectl get ec2nodeclass
kubectl get pdb -A
helm list -n karpenter
kubectl get pods -n karpenter
```

Before a production rollout, also:

- Verify controller and node IAM permissions and that EC2 capacity is available.
- Save the rendered Helm values and versions of Karpenter and its CRDs.
- Review the Karpenter upgrade guide for version-specific CRD/API changes.
- Confirm workload PDBs, spare capacity, and a rollback plan.
- Choose an AL2023 AMI alias supported for the target Kubernetes version.

See the [Karpenter v1.14 upgrade guide](https://karpenter.sh/v1.14/upgrading/upgrade-guide/)
and [EC2NodeClass AMI selector documentation](https://karpenter.sh/v1.14/concepts/nodeclasses/#specamiselectorterms).

---

## 2. Create the Canary Infrastructure

The canary EC2NodeClass intentionally has its own name, while reusing the
cluster's existing subnet and security-group discovery tags and instance
profile. Update `soni-cluster` and the instance-profile name in
`k8s/karpenter/ec2nodeclass-upgrade-canary.yaml` if your cluster uses different
values.

```bash
kubectl apply -f k8s/karpenter/ec2nodeclass-upgrade-canary.yaml
kubectl get ec2nodeclass upgrade-canary
```

After the EC2NodeClass reports Ready, create the canary NodePool and test
workload:

```bash
kubectl apply -f k8s/karpenter/nodepool-upgrade-canary.yaml
kubectl apply -f k8s/labs/upgrade-canary-workload.yaml
kubectl rollout status deployment/upgrade-canary -n karpenter-upgrade-lab
kubectl get pods -n karpenter-upgrade-lab -o wide
kubectl get nodes -l nodepool=upgrade-canary
```

This pool has its own capacity limit and a one-node disruption budget. The
canary workload has two replicas on separate nodes and a PDB that allows one
replica to be unavailable during a voluntary rollout.

---

## 3. Change the Canary AMI

Edit only
`k8s/karpenter/ec2nodeclass-upgrade-canary.yaml`. Replace `al2023@latest` with
the exact, supported, pinned AL2023 alias for the target Kubernetes version,
then apply the canary EC2NodeClass:

```bash
kubectl apply -f k8s/karpenter/ec2nodeclass-upgrade-canary.yaml
kubectl describe ec2nodeclass upgrade-canary
```

Do not guess an AMI alias or use an AMI built for a different Kubernetes
version. Check that the EC2NodeClass is Ready and resolves the expected AMI
before proceeding. Karpenter detects the changed NodeClass configuration as
drift and replaces eligible canary nodes, subject to the NodePool disruption
budget and workload PDB.

Watch the rollout:

```bash
kubectl get nodeclaims -w
kubectl get nodes -l nodepool=upgrade-canary -w
kubectl get pods -n karpenter-upgrade-lab -o wide
kubectl get pdb -n karpenter-upgrade-lab
kubectl get events -A --sort-by=.lastTimestamp
```

Verify that replacement nodes join, canary pods become Ready, and old
NodeClaims are removed. If new nodes fail to launch, inspect the EC2NodeClass
conditions, NodeClaim events, Karpenter logs, EC2 quota/capacity, and IAM errors
before making any change to other NodePools.

---

## 4. Rollback the Canary

If the new AMI fails validation, set the canary EC2NodeClass back to the
previous known-good alias and apply it again. Karpenter will drift the
canary nodes back to that configuration. Do not delete NodeClaims manually
while pods are running on them.

Treat a production rollback as another controlled rollout: check the PDB,
NodePool budgets, capacity, and application health.

---

## 5. Upgrade Sequencing Notes

An EKS or Karpenter version upgrade is not performed by this canary. For a
real release:

1. Review EKS and Karpenter compatibility, release notes, CRD changes, IAM
   changes, and deprecated APIs.
2. Validate the change in a staging cluster with the same critical add-ons and
   representative workloads.
3. Follow the supported EKS control-plane and managed-node upgrade order for
   your target versions.
4. Upgrade Karpenter's controller and CRDs together when the version's guide
   requires it; do not assume a Helm controller upgrade also updates CRDs.
5. Roll out target-version AMIs through a canary NodePool, then expand
   gradually while watching readiness, PDBs, disruption events, and pending
   pods.

---

## 6. Clean Up

```bash
kubectl delete namespace karpenter-upgrade-lab
kubectl delete -f k8s/karpenter/nodepool-upgrade-canary.yaml
kubectl delete -f k8s/karpenter/ec2nodeclass-upgrade-canary.yaml
```

---

## Production Takeaways

- Separate canary NodePools and EC2NodeClasses limit blast radius.
- Pin and validate AMIs against the intended EKS Kubernetes version.
- Use drift, disruption budgets, PDBs, health checks, and a known-good
  rollback target together.
- Upgrade CRDs and controller versions according to the release-specific
  Karpenter guide.

**Related:** [Lab 06 — Consolidation](./06-consolidation.md) ·
[Lab 09 — NodePool Disruption Budgets](./09-nodepool-disruption-budgets.md)
