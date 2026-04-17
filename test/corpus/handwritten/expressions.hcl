arithmetic     = 1 + 2 * 3 - 4 / 2
logical        = a && !b || c
comparisons    = x < y && y <= z && z != 0
conditional    = a > 0 ? "positive" : "nonpositive"
unary_stack    = !!cond
paren_grouping = (a + b) * (c - d)

func_call     = max(1, 2, 3)
variadic      = concat(list1, list2...)
member_call   = coalesce(var.a, var.b, "default")

tuple_inline  = [1, 2, 3]
tuple_trail   = [1, 2, 3,]
tuple_mixed   = [1, "two", true, null]
tuple_empty   = []

object_inline = { a = 1, b = 2 }
object_empty  = {}
object_colon  = { "k": 1, "l": 2 }

splat_attr    = var.instances.*.id
splat_full    = var.instances[*].tags["Name"]
chain         = local.x.y[0].z

for_tuple     = [for v in xs : v * 2 if v > 0]
for_object    = { for k, v in m : k => upper(v) }
for_group     = { for k, v in m : v => k... }
