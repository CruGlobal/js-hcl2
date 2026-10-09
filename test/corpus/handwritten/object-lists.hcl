# Lists of objects. One block parses as an object, not a one-item list,
# so stringify must keep a one-item list as a tuple. Repeated blocks
# parse as a list and must not have their keys peeled into labels.

variable "services" {
  type = list(object({ name = string }))
  default = [
    { name = "app" },
  ]
}

variable "metric_namespaces" {
  default = [{ id = "compute", disabled = true, filters = [] }]
}

resource "google_storage_bucket" "logs" {
  name     = "logs"
  location = "US"

  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
    condition {
      age = 30
    }
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 365
    }
  }
}

locals {
  volume_defaults = [
    {
      name           = "datadog"
      host_path      = "/opt/datadog"
      container_path = "/var/run/datadog"
      read_only      = true
    },
  ]
  pairs = [{ a = 1 }, { a = 2 }]
}
