plain_single_line = <<EOT
just one line
EOT

plain_multi = <<EOT
line 1
line 2
line 3
EOT

strip_form = <<-EOT
  leading whitespace
  preserved structurally
  EOT

with_interp = <<END
hello ${name}
bye ${greeting}
END

mixed_delimiters = <<XYZ
body content
XYZ

with_dollar_escape = <<EOT
price: $${amount}
EOT

empty_heredoc = <<EOT
EOT
