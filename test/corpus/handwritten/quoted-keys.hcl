# Object attributes whose keys need quotes. A block body can only hold
# bare names, so stringify must write these back as attributes.

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = "github"
  workload_identity_pool_provider_id = "github-actions"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "aws_subnet" "private" {
  for_each = {
    "1a" = "10.16.32.0/24"
    "1b" = "10.16.33.0/24"
  }
  vpc_id            = var.vpc_id
  cidr_block        = each.value
  availability_zone = "us-east-1${each.key}"
}

module "folder_iam" {
  source  = "terraform-google-modules/iam/google//modules/folders_iam"
  folders = [google_folder.app.name]
  mode    = "additive"
  bindings = {
    "roles/viewer" = [
      "group:team@example.org",
    ]
    "roles/resourcemanager.folderViewer" = ["group:team@example.org"]
  }
}

locals {
  base_flags = {
    "cloudsql.iam_authentication" = "on"
    log_min_duration_statement    = "1000"
  }
  tags = {
    Name                     = "web"
    "kubernetes.io/role/elb" = "1"
    ""                       = "empty key"
    "for"                    = "keyword key"
    "null"                   = "keyword key"
  }
  rules = [
    { "a.b" = 1 },
    { "c/d" = 2 },
  ]
}

path "secret/data/*" {
  capabilities = ["read", "list"]
}

a "" {
  x = var.y
}
