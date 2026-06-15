variable "api_p12_file" {
  description = "Path to the Volterra API P12 certificate file"
  type        = string
}

variable "api_url" {
  description = "F5 XC API URL (e.g. https://<tenant>.console.ves.volterra.io/api)"
  type        = string
}

variable "tenant_name" {
  description = "XC tenant name (used in object references)"
  type        = string
}

variable "base_domain" {
  description = "Base domain for LB FQDN construction — set via TF_VAR_base_domain"
  type        = string
}

variable "shared_namespace" {
  description = "Namespace for shared resources (WAF, service policies, origin pool)"
  type        = string
  default     = "shared"
}

variable "namecheap_domain" {
  description = "Domain managed in Namecheap for DNS-01 ACME challenge records — set via TF_VAR_namecheap_domain"
  type        = string
}

variable "enable_malware_protection" {
  description = "Enable malware protection on LBs that support it. Set to false if the tenant lacks the addon."
  type        = bool
  default     = false
}

variable "enable_client_side_defense" {
  description = "Enable client-side defense on LBs that support it. Set to false if the tenant lacks the f5xc-client-side-defense-standard addon."
  type        = bool
  default     = false
}
