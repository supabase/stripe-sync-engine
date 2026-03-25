terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# ---------- VPC / networking (existing) ----------

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# ---------- RDS PostgreSQL (existing) ----------

resource "aws_security_group" "postgres" {
  name        = "sync-engine-postgres"
  description = "Allow PostgreSQL inbound"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "postgres" {
  identifier     = "sync-engine-sandbox"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.micro"

  allocated_storage = 20
  storage_type      = "gp2"

  db_name  = "sync_engine"
  username = var.db_username
  password = var.db_password

  publicly_accessible    = true
  skip_final_snapshot    = true
  vpc_security_group_ids = [aws_security_group.postgres.id]
}

# ---------- SQS ----------

resource "aws_sqs_queue" "events" {
  name                       = "sync-engine-events"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 86400
}

# ---------- IAM ----------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# -- producer role --
resource "aws_iam_role" "producer" {
  name               = "sync-engine-webhook-receiver"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "producer_basic" {
  role       = aws_iam_role.producer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "producer_sqs" {
  name = "sqs-send"
  role = aws_iam_role.producer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = [aws_sqs_queue.events.arn]
    }]
  })
}

# -- consumer role --
resource "aws_iam_role" "consumer" {
  name               = "sync-engine-consumer"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "consumer_basic" {
  role       = aws_iam_role.consumer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "consumer_sqs" {
  name = "sqs-consume"
  role = aws_iam_role.consumer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ]
      Resource = [aws_sqs_queue.events.arn]
    }]
  })
}

# ---------- ECR ----------

resource "aws_ecr_repository" "sync_engine" {
  name         = "sync-engine"
  force_delete = true
}

# ---------- ECS Cluster ----------

resource "aws_ecs_cluster" "sync_engine" {
  name = "sync-engine"
}

# ---------- CloudWatch Logs ----------

resource "aws_cloudwatch_log_group" "sync_engine" {
  name              = "/ecs/sync-engine"
  retention_in_days = 7
}

# ---------- ECS Task Execution Role ----------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name               = "sync-engine-ecs-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ---------- ECS Task Definition ----------

data "aws_caller_identity" "current" {}

resource "aws_ecs_task_definition" "sync_engine" {
  family                   = "sync-engine"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn

  container_definitions = jsonencode([{
    name      = "sync-engine"
    image     = "${aws_ecr_repository.sync_engine.repository_url}:latest"
    essential = true

    portMappings = [{
      containerPort = 3000
      protocol      = "tcp"
    }]

    environment = [
      { name = "PORT", value = "3000" },
      { name = "DB_HOST", value = aws_db_instance.postgres.address },
      { name = "DB_PORT", value = tostring(aws_db_instance.postgres.port) },
      { name = "DB_NAME", value = aws_db_instance.postgres.db_name },
      { name = "DB_USERNAME", value = var.db_username },
      { name = "DB_PASSWORD", value = var.db_password },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.sync_engine.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}

# ---------- ALB ----------

resource "aws_security_group" "alb" {
  name        = "sync-engine-alb"
  description = "Allow HTTP inbound to ALB"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "sync_engine" {
  name               = "sync-engine"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids
  idle_timeout       = 120
}

resource "aws_lb_target_group" "sync_engine" {
  name        = "sync-engine"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "ip"

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

resource "aws_lb_listener" "sync_engine" {
  load_balancer_arn = aws_lb.sync_engine.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.sync_engine.arn
  }
}

# ---------- ECS Security Group ----------

resource "aws_security_group" "ecs" {
  name        = "sync-engine-ecs"
  description = "Allow traffic from ALB to ECS tasks"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------- ECS Service ----------

resource "aws_ecs_service" "sync_engine" {
  name            = "sync-engine"
  cluster         = aws_ecs_cluster.sync_engine.id
  task_definition = aws_ecs_task_definition.sync_engine.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.sync_engine.arn
    container_name   = "sync-engine"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.sync_engine]
}

# ---------- Lambda: sync-message-producer ----------

resource "aws_lambda_function" "producer" {
  function_name = "sync-engine-webhook-receiver"
  role          = aws_iam_role.producer.arn
  handler       = "lambda_function.lambda_handler"
  runtime       = "ruby3.3"
  architectures = ["arm64"]
  timeout       = 120
  memory_size   = 256

  filename         = "lambda/webhook-receiver/webhook-receiver.zip"
  source_code_hash = filebase64sha256("lambda/webhook-receiver/webhook-receiver.zip")

  environment {
    variables = {
      SYNC_ENGINE_URL = "http://${aws_lb.sync_engine.dns_name}"
      SQS_QUEUE_URL   = aws_sqs_queue.events.url
    }
  }
}

resource "aws_lambda_function_url" "producer" {
  function_name      = aws_lambda_function.producer.function_name
  authorization_type = "NONE"
}

# NONE-auth Function URLs require both InvokeFunctionUrl (auto-created) and InvokeFunction
resource "aws_lambda_permission" "producer_public_invoke" {
  statement_id  = "FunctionURLInvokeAllowPublicAccess"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.producer.function_name
  principal     = "*"
}

# ---------- Lambda: consumer ----------

resource "aws_lambda_function" "consumer" {
  function_name = "sync-engine-consumer"
  role          = aws_iam_role.consumer.arn
  handler       = "lambda_function.lambda_handler"
  runtime       = "ruby3.3"
  architectures = ["arm64"]
  timeout       = 60
  memory_size   = 256

  filename         = "lambda/consumer/consumer.zip"
  source_code_hash = filebase64sha256("lambda/consumer/consumer.zip")

  environment {
    variables = {
      SYNC_ENGINE_URL = "http://${aws_lb.sync_engine.dns_name}"
    }
  }
}

resource "aws_lambda_event_source_mapping" "consumer_sqs" {
  event_source_arn = aws_sqs_queue.events.arn
  function_name    = aws_lambda_function.consumer.arn
  batch_size       = 10
  enabled          = true
}

# ---------- Real Sync Engine (Docker Hub image) ----------

resource "aws_cloudwatch_log_group" "real_sync_engine" {
  name              = "/ecs/real-sync-engine"
  retention_in_days = 7
}

resource "aws_ecs_task_definition" "real_sync_engine" {
  family                   = "real-sync-engine"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "real-sync-engine"
    image     = "stripe/sync-engine:v2"
    essential = true

    portMappings = [{
      containerPort = 3000
      protocol      = "tcp"
    }]

    environment = [
      { name = "PORT", value = "3000" },
      { name = "DATABASE_URL", value = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.postgres.address}:${aws_db_instance.postgres.port}/${aws_db_instance.postgres.db_name}" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.real_sync_engine.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}

resource "aws_lb_target_group" "real_sync_engine" {
  name        = "real-sync-engine"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "ip"

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

resource "aws_lb_listener" "real_sync_engine" {
  load_balancer_arn = aws_lb.sync_engine.arn
  port              = 8080
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.real_sync_engine.arn
  }
}

resource "aws_security_group" "real_sync_engine_ecs" {
  name        = "real-sync-engine-ecs"
  description = "Allow traffic from ALB to real sync engine ECS tasks"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_service" "real_sync_engine" {
  name            = "real-sync-engine"
  cluster         = aws_ecs_cluster.sync_engine.id
  task_definition = aws_ecs_task_definition.real_sync_engine.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.real_sync_engine_ecs.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.real_sync_engine.arn
    container_name   = "real-sync-engine"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.real_sync_engine]
}

# ---------- Moved blocks (rename webhook-receiver → producer) ----------

moved {
  from = aws_iam_role.webhook_receiver
  to   = aws_iam_role.producer
}

moved {
  from = aws_iam_role_policy_attachment.webhook_receiver_basic
  to   = aws_iam_role_policy_attachment.producer_basic
}

moved {
  from = aws_iam_role_policy.webhook_receiver_sqs
  to   = aws_iam_role_policy.producer_sqs
}

moved {
  from = aws_lambda_function.webhook_receiver
  to   = aws_lambda_function.producer
}

moved {
  from = aws_lambda_function_url.webhook_receiver
  to   = aws_lambda_function_url.producer
}

moved {
  from = aws_lambda_permission.webhook_receiver_public_invoke
  to   = aws_lambda_permission.producer_public_invoke
}
