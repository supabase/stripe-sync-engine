#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

AWS_REGION=$(terraform output -raw 2>/dev/null <<< "" || echo "us-west-2")
AWS_REGION="${AWS_REGION:-us-west-2}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/sync-engine"

echo "=== Building producer ==="
(cd lambda/producer && zip -j webhook-receiver.zip lambda_function.rb)
# Terraform references the old path via symlink: lambda/webhook-receiver → lambda/producer

echo "=== Building consumer ==="
(cd lambda/consumer && zip -j consumer.zip lambda_function.rb)

echo "=== Building sync-engine Docker image ==="
cd lambda/sync-engine
docker build --platform linux/amd64 -t sync-engine .

echo "=== Pushing sync-engine to ECR ==="
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

docker tag sync-engine:latest "${ECR_REPO}:latest"
docker push "${ECR_REPO}:latest"

cd ../..
echo "=== Build complete ==="
echo "  producer:         lambda/webhook-receiver/webhook-receiver.zip"
echo "  consumer:         lambda/consumer/consumer.zip"
echo "  sync-engine:      ${ECR_REPO}:latest"
