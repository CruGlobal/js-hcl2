# Identifiers may start with an underscore. HCL's reference scanner
# defines Ident as (ID_Start | '_') (ID_Continue | '-')*.

import {
  to = aws_route53_record._46fe0a1b_example_org_A
  id = "Z123_example.org_A"
}

locals {
  _private = "internal"
  values   = [for _, v in var.items : v]
  renamed  = { for _k, _v in var.map : _k => _v }
  joined   = "%{ for _, s in local.list }${s}%{ endfor }"
  picked   = local._private
  splat    = var.things[*]._id
}

_leading_block "label" {
  _attr = _helper(local._private)
}

output "heredoc" {
  value = <<-_EOT
    underscore delimiter
    _EOT
}
