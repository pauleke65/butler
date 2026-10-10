#!/usr/bin/env bash
# After a failed first deploy (stack in ROLLBACK_COMPLETE): delete the stack and the runtime log groups AgentCore
# created itself, so the next deploy starts clean. Usage: AWS_PROFILE=... bash scripts/cleanup-failed-stack.sh [stage]
set -euo pipefail
STAGE="${1:-dev}"; STACK="butler-$STAGE"; REGION="${AWS_REGION:-us-east-1}"
status=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE)
echo "stack $STACK: $status"
if [ "$status" = "ROLLBACK_COMPLETE" ] || [ "$status" = "DELETE_FAILED" ]; then
  aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
  aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK" && echo "deleted $STACK"
fi
for g in $(aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "/aws/bedrock-agentcore/runtimes/butler_${STAGE}" --query 'logGroups[].logGroupName' --output text); do
  aws logs delete-log-group --region "$REGION" --log-group-name "$g" && echo "deleted $g"
done
for s in $(aws secretsmanager list-secrets --region "$REGION" --include-planned-deletion --filters Key=name,Values="butler/$STAGE/" --query 'SecretList[?DeletedDate!=`null`].Name' --output text); do
  aws secretsmanager delete-secret --region "$REGION" --secret-id "$s" --force-delete-without-recovery >/dev/null && echo "purged secret $s"
done
