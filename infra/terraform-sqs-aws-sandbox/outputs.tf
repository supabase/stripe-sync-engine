output "db_endpoint" {
  description = "RDS endpoint"
  value       = aws_db_instance.postgres.endpoint
}

output "db_connection_string" {
  description = "PostgreSQL connection string"
  value       = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.postgres.endpoint}/${aws_db_instance.postgres.db_name}"
  sensitive   = true
}

output "webhook_receiver_url" {
  description = "Sync-message-producer Function URL (no auth)"
  value       = aws_lambda_function_url.producer.function_url
}

output "sync_engine_url" {
  description = "Sync engine ALB URL"
  value       = "http://${aws_lb.sync_engine.dns_name}"
}

output "sqs_queue_url" {
  description = "SQS queue URL"
  value       = aws_sqs_queue.events.url
}
