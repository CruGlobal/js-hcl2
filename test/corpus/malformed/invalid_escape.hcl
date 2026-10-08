# HCL defines only \n \r \t \" \\ \uNNNN and \UNNNNNNNN in quoted
# strings. Terraform rejects "\." with "Invalid escape sequence".
description = "ends with a backslash \. more"
