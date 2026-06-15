# -----------------------------------------------------------------------------
# DNS-01 ACME Challenge Records
#
# Reads auto_cert_info from each HTTPS auto-cert LB, extracts the CNAME
# challenge records, and creates them in Namecheap using MERGE mode
# (only touches our records, leaves existing DNS intact).
#
# Auth: set NAMECHEAP_USER_NAME, NAMECHEAP_API_USER, NAMECHEAP_API_KEY,
#       and NAMECHEAP_CLIENT_IP as environment variables.
# -----------------------------------------------------------------------------

# --- Data sources: read LB state to get auto-cert DNS records ---

locals {
  https_lbs = {
    baseline_standard = {
      name      = volterra_http_loadbalancer.baseline_standard.name
      namespace = "default"
    }
    s1_compliant = {
      name      = volterra_http_loadbalancer.s1_compliant.name
      namespace = volterra_namespace.baseline.name
    }
    s1_below_baseline = {
      name      = volterra_http_loadbalancer.s1_below_baseline.name
      namespace = volterra_namespace.baseline.name
    }
    s1_above_baseline = {
      name      = volterra_http_loadbalancer.s1_above_baseline.name
      namespace = volterra_namespace.baseline.name
    }
    s2_enterprise_ready = {
      name      = volterra_http_loadbalancer.s2_enterprise_ready.name
      namespace = volterra_namespace.plan.name
    }
    s2_essentials_only = {
      name      = volterra_http_loadbalancer.s2_essentials_only.name
      namespace = volterra_namespace.plan.name
    }
    s3_labeled_compliant = {
      name      = volterra_http_loadbalancer.s3_labeled_compliant.name
      namespace = volterra_namespace.labels.name
    }
    s3_partial_labels = {
      name      = volterra_http_loadbalancer.s3_partial_labels.name
      namespace = volterra_namespace.labels.name
    }
    s3_no_labels = {
      name      = volterra_http_loadbalancer.s3_no_labels.name
      namespace = volterra_namespace.labels.name
    }
    s4_ecommerce = {
      name      = volterra_http_loadbalancer.s4_ecommerce.name
      namespace = volterra_namespace.workloads.name
    }
    s4_partner_api = {
      name      = volterra_http_loadbalancer.s4_partner_api.name
      namespace = volterra_namespace.workloads.name
    }
    s4_marketing = {
      name      = volterra_http_loadbalancer.s4_marketing.name
      namespace = volterra_namespace.workloads.name
    }
    s4_staging = {
      name      = volterra_http_loadbalancer.s4_staging.name
      namespace = volterra_namespace.workloads.name
    }
  }
}

data "volterra_http_loadbalancer_state" "lbs" {
  for_each = local.https_lbs

  name      = each.value.name
  namespace = each.value.namespace
}

# --- Flatten all DNS records into a single list for Namecheap ---

locals {
  domain_suffix = ".${var.namecheap_domain}"

  all_dns_records = flatten([
    for key, state in data.volterra_http_loadbalancer_state.lbs : [
      for record in try(state.auto_cert_info[0].dns_records, []) : {
        hostname = trimsuffix(record.name, local.domain_suffix)
        address  = record.value
      } if record.type == "CNAME"
    ]
  ])
}

# --- Create CNAME records in Namecheap (MERGE mode) ---

resource "namecheap_domain_records" "acme_challenges" {
  domain = var.namecheap_domain
  mode   = "MERGE"

  dynamic "record" {
    for_each = local.all_dns_records
    content {
      hostname = record.value.hostname
      type     = "CNAME"
      address  = record.value.address
      ttl      = 300
    }
  }
}
