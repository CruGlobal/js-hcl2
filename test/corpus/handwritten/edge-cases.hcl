# Edge cases that have historically broken HCL parsers.

# Empty block
empty {}

# Block with blank-line-separated statements
spaced {
  a = 1

  b = 2

  c = 3
}

# One-liner block
tight { x = 1 }

# Multiple labels
nested "a" "b" "c" "d" {
  deep = true
}

# Blocks with the same type/labels — repeat semantics
repeat "same" {
  first = 1
}
repeat "same" {
  first = 2
}

# Attributes with every primitive kind
primitives {
  int_val    = 42
  float_val  = 3.14
  neg_val    = -17
  zero_val   = 0
  big_val    = 1000000
  sci_val    = 1.5e-10
  true_val   = true
  false_val  = false
  null_val   = null
  empty_str  = ""
  short_str  = "a"
  tab_escape = "a\tb"
  crlf       = "a\r\nb"
}

# Dashes in identifiers (HCL-specific extension of UAX #31)
dash-key = "value"
a-b-c = 1

# Trailing commas everywhere
trail_tuple = [1, 2, 3,]
trail_call  = f(a, b, c,)
trail_obj   = { a = 1, b = 2, }

# Deeply nested structures
deeply_nested = {
  a = {
    b = {
      c = {
        d = [1, 2, { e = "leaf" }]
      }
    }
  }
}
