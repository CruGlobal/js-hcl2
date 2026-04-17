terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }

  backend "s3" {
    bucket         = "my-tf-state"
    key            = "env/dev/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "tf-locks"
  }
}

variable "env" {
  type        = string
  description = "Deployment environment"
  default     = "dev"
}

variable "tags" {
  type = map(string)
  default = {
    Owner       = "team"
    Environment = "shared"
  }
}

locals {
  region   = "us-east-1"
  app_name = "my-app"

  common_tags = merge(var.tags, {
    Application = local.app_name
    Env         = var.env
  })
}

resource "aws_s3_bucket" "data" {
  bucket = "${local.app_name}-${var.env}-data"

  tags = local.common_tags
}

resource "aws_s3_bucket_versioning" "data" {
  bucket = aws_s3_bucket.data.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_iam_role" "runner" {
  name = "${local.app_name}-runner"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = local.common_tags
}

output "bucket_arn" {
  value       = aws_s3_bucket.data.arn
  description = "ARN of the provisioned data bucket"
}

output "role_name" {
  value = aws_iam_role.runner.name
}
