# karpenter-on-eks

Hands-on labs for learning Karpenter on Amazon EKS, from cluster prerequisites
and basic node provisioning to production operations.

## Labs

| Lab | Topic |
| --- | --- |
| [00 — Prerequisites & Cluster Validation](./labs/00-prerequisites.md) | Validate the EKS cluster and collect required configuration |
| [01 — Install Karpenter](./labs/01-install-karpenter.md) | Set up IAM, interruption infrastructure, and the controller |
| [02 — NodePool & EC2NodeClass Basics](./labs/02-nodepool-basics.md) | Configure node provisioning constraints and limits |
| [03 — Deploy the ShopFront Application](./labs/03-deploy-app.md) | Deploy workloads used in later experiments |
| [04 — Scaling Lab](./labs/04-scaling-lab.md) | Observe workload scale-out and scale-in |
| [05 — Spot Interruption Handling](./labs/05-spot-interruption.md) | Handle Spot reclamation events |
| [06 — Consolidation](./labs/06-consolidation.md) | Explore consolidation, drift, and disruption blockers |
| [07 — Advanced Scheduling](./labs/07-advanced-scheduling.md) | Schedule workloads onto specialized NodePools |
| [08 — Production Best Practices](./labs/08-production-best-practices.md) | Review operational practices and production readiness |
| [09 — NodePool Disruption Budgets](./labs/09-nodepool-disruption-budgets.md) | Control the rate of voluntary node disruptions and maintenance windows |
| [10 — Stateful Workloads](./labs/10-stateful-workloads.md) | Explore EBS persistence, AZ topology, and workload recovery |
| [11 — Safe Node and Cluster Upgrades](./labs/11-safe-node-and-cluster-upgrades.md) | Practice canary AMI rollouts and upgrade planning |
| [12 — Troubleshooting Provisioning](./labs/12-troubleshooting-provisioning.md) | Diagnose unschedulable pods and AWS-side provisioning failures |
| [13 — Node Health and Auto Repair](./labs/13-node-health-and-repair.md) | Review Node Auto Repair prerequisites, health signals, and safeguards |

Complete Labs 00–08 in order to build the cluster and application. Lab 09 is
an advanced production exercise with its own NodePool manifest at
[`k8s/karpenter/nodepool-budget-lab.yaml`](./k8s/karpenter/nodepool-budget-lab.yaml);
it does not modify the `general-purpose` NodePool. Labs 10–13 are additional
production-focused exercises; review each lab's AWS resource and sandbox
requirements before starting.
