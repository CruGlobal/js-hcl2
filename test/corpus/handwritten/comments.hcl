# top-level file header
// slash-style header

/*
 * Multi-line block comment at the top.
 * Preserves blank line + star indent.
 */

attr_with_trail = 1 # same-line # comment
attr_slash_trail = 2 // same-line // comment
attr_block_trail = 3 /* same-line block */

# leading comment for a block
block "labeled" {
  # leading comment inside a block
  inner_attr = "value" # trailing inside block

  // siblings separated by comments
  sibling = true
}

# trailing file comment with no following statement
