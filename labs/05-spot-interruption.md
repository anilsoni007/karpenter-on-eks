# Lab 05 — Spot Interruption Handling

Spot instances can be reclaimed by AWS with a 2-minute warning. This lab sets up the interruption handling infrastructure and demonstrates how Karpenter gracefully drains nodes before they disappear.

---

## How Karpenter Handles Interruptions

Without Karpenter's interruption handling, a Spot reclamation would abruptly terminate the EC2 instance, killing all pods on it with no warning.

With Karpenter's interruption handling:

```
AWS sends Spot interruption notice (2-min warning)
    │
    ▼
EventBridge rule captures the event
    │
    ▼
Event forwarded to SQS queue
    │
    ▼
Karpenter controller polls SQS
    │
    ▼
Karpenter cordons the node (no new pods)
    │
    ▼
Karpenter drains the node (evicts pods gracefully)
    │
    ▼
Pods reschedule on other nodes (or trigger new node provisioning)
    │
    ▼
EC2 instance terminates (2 min after notice)
```

**Why SQS instead of direct API polling?**  
EventBridge + SQS is a push model — AWS pushes the interruption event to your queue. Karpenter polls the queue. This is more reliable than polling EC2 APIs and works even if the Karpenter pod briefly restarts.

---

## 1. Create the SQS Interruption Queue

> **Important:** Karpenter tries to connect to this queue at startup. If the queue doesn't exist, you'll see `SQS GetQueueUrl NonExistentQueue` errors in the Karpenter logs immediately after install. Create this queue **before** installing Karpenter, or run `helm upgrade --reuse-values` after creating it to trigger a pod restart.

```bash
# WHY this must exist BEFORE helm install:
# Karpenter's interruption controller calls sqs:GetQueueUrl at startup to validate
# the queue. If the queue is missing it logs: AWS.SimpleQueueService.NonExistentQueue
# and the interruption controller fails — meaning Spot interruptions won't be handled.
# The rest of Karpenter still works, but you lose graceful drain on Spot reclamation.
#
# If you already installed Karpenter without the queue, create it now then restart:
#   aws sqs create-queue --queue-name Karpenter-${CLUSTER_NAME} \
#     --attributes '{"MessageRetentionPeriod":"300","SqsManagedSseEnabled":"true"}'
#   helm upgrade karpenter oci://public.ecr.aws/karpenter/karpenter \
#     --version 1.14.1 --namespace karpenter --reuse-values
aws sqs create-queue \
  --queue-name Karpenter-${CLUSTER_NAME} \
  --attributes '{
    "MessageRetentionPeriod": "300",
    "SqsManagedSseEnabled": "true"
  }'
```

**Why `MessageRetentionPeriod: 300`?**  
5 minutes is enough — Karpenter processes messages quickly. Keeping messages longer wastes storage and could cause Karpenter to act on stale events after a controller restart.

---

## 2. Set the SQS Queue Policy

The queue must allow EventBridge and EC2 to send messages to it.

```bash
QUEUE_URL=$(aws sqs get-queue-url \
  --queue-name Karpenter-${CLUSTER_NAME} \
  --query QueueUrl --output text)

QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url $QUEUE_URL \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

cat > /tmp/queue-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": ["events.amazonaws.com", "sqs.amazonaws.com"]
      },
      "Action": "sqs:SendMessage",
      "Resource": "${QUEUE_ARN}"
    }
  ]
}
EOF

aws sqs set-queue-attributes \
  --queue-url $QUEUE_URL \
  --attributes Policy=$(cat /tmp/queue-policy.json | jq -c . | jq -R .)
```

---

## 3. Create EventBridge Rules

Four event types feed into the interruption queue:

```bash
# 1. Spot Instance Interruption Warning — the most important one
aws events put-rule \
  --name KarpenterSpotInterruption-${CLUSTER_NAME} \
  --event-pattern '{"source":["aws.ec2"],"detail-type":["EC2 Spot Instance Interruption Warning"]}' \
  --state ENABLED

# 2. Instance Rebalance Recommendation — early warning before interruption
aws events put-rule \
  --name KarpenterRebalance-${CLUSTER_NAME} \
  --event-pattern '{"source":["aws.ec2"],"detail-type":["EC2 Instance Rebalance Recommendation"]}' \
  --state ENABLED

# 3. Instance State Change — catches unexpected terminations
aws events put-rule \
  --name KarpenterInstanceStateChange-${CLUSTER_NAME} \
  --event-pattern '{"source":["aws.ec2"],"detail-type":["EC2 Instance State-change Notification"]}' \
  --state ENABLED

# 4. Scheduled Maintenance — AWS maintenance events
aws events put-rule \
  --name KarpenterScheduledChange-${CLUSTER_NAME} \
  --event-pattern '{"source":["aws.health"],"detail-type":["AWS Health Event"]}' \
  --state ENABLED
```

**Why the Rebalance Recommendation?**  
AWS sends a rebalance recommendation *before* the interruption warning when Spot capacity is tightening. Karpenter can proactively migrate pods when it receives this signal, giving you more than the standard 2-minute window.

---

## 4. Add SQS as EventBridge Target

```bash
for RULE in \
  KarpenterSpotInterruption-${CLUSTER_NAME} \
  KarpenterRebalance-${CLUSTER_NAME} \
  KarpenterInstanceStateChange-${CLUSTER_NAME} \
  KarpenterScheduledChange-${CLUSTER_NAME}; do
  aws events put-targets \
    --rule $RULE \
    --targets "Id=KarpenterSQS,Arn=${QUEUE_ARN}"
done
```

---

## 5. Verify Karpenter is Watching the Queue

The queue name was passed to Helm during installation (`--set settings.interruptionQueue=Karpenter-${CLUSTER_NAME}`). Verify:

```bash
# In Karpenter 1.x, settings are stored in the Deployment env vars, not a ConfigMap
kubectl get deployment karpenter -n karpenter -o jsonpath='{.spec.template.spec.containers[0].env}' | \
  jq '.[] | select(.name=="INTERRUPTION_QUEUE")'
```

---

## 6. Simulate a Spot Interruption

AWS doesn't let you trigger real Spot interruptions on demand, but you can simulate one by sending a fake event to the SQS queue.

```bash
# Get the instance ID of a Spot node
SPOT_NODE=$(kubectl get nodes -l karpenter.sh/capacity-type=spot \
  -o jsonpath='{.items[0].metadata.name}')

INSTANCE_ID=$(kubectl get node $SPOT_NODE \
  -o jsonpath='{.spec.providerID}' | cut -d'/' -f5)

echo "Simulating interruption for instance: $INSTANCE_ID on node: $SPOT_NODE"

# Send a fake Spot interruption notice to the SQS queue
aws sqs send-message \
  --queue-url $QUEUE_URL \
  --message-body "{
    \"version\": \"0\",
    \"id\": \"test-event-$(date +%s)\",
    \"detail-type\": \"EC2 Spot Instance Interruption Warning\",
    \"source\": \"aws.ec2\",
    \"account\": \"${AWS_ACCOUNT_ID}\",
    \"time\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"region\": \"${AWS_REGION}\",
    \"detail\": {
      \"instance-id\": \"${INSTANCE_ID}\",
      \"instance-action\": \"terminate\"
    }
  }"
```

---

## 7. Watch the Graceful Drain

```bash
# Terminal 1 — watch the node get cordoned and drained
kubectl get nodes -w

# Terminal 2 — watch pods migrate
kubectl get pods -n shopfront -o wide -w

# Terminal 3 — watch Karpenter logs
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter -f | grep -i "interrupt\|drain\|cordon"
```

**What you'll see:**
1. Karpenter receives the SQS message
2. Node is cordoned (`SchedulingDisabled`)
3. Pods are evicted (respecting PDBs)
4. Pods reschedule on other nodes or trigger new node provisioning
5. Node is terminated

---

## 8. Why the Worker Handles This Gracefully

The worker pod has:
- `terminationGracePeriodSeconds: 60` — gives it 60s to finish
- SIGTERM handler in `worker.py` — catches the signal and finishes the current job
- `preStop` hook — adds 5s buffer before SIGTERM

When Karpenter evicts the worker pod, Kubernetes sends SIGTERM. The worker finishes its current job (max ~8s based on the code) and exits cleanly. No job is lost.

**What would happen without graceful shutdown?**  
The pod would be killed mid-job with SIGKILL after `terminationGracePeriodSeconds`. Any in-progress work would be lost and would need to be retried.

---

## Key Takeaways

- Spot interruptions give 2 minutes warning — Karpenter uses this to drain gracefully
- EventBridge + SQS is the reliable path for interruption events
- Rebalance recommendations give even earlier warning
- PDBs prevent all pods from being evicted simultaneously
- `terminationGracePeriodSeconds` + SIGTERM handlers = zero job loss

**Next:** [Lab 06 — Consolidation](./06-consolidation.md)
