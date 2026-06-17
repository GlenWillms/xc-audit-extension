# -----------------------------------------------------------------------------
# DNS Records for Demo LBs
#
# Creates two types of DNS records in Namecheap (MERGE mode):
#   1. A records — point each LB domain to the XC anycast VIP
#   2. CNAME records — DNS-01 ACME challenges for auto-cert LBs
#
# Auth: set NAMECHEAP_USER_NAME, NAMECHEAP_API_USER, NAMECHEAP_API_KEY,
#       and NAMECHEAP_CLIENT_IP as environment variables.
# -----------------------------------------------------------------------------

# --- Data sources: read LB state to get VIP IP and auto-cert DNS records ---

locals {
  all_lbs = {
    baseline_standard = {
      name      = volterra_http_loadbalancer.baseline_standard.name
      namespace = "default"
      hostname  = "baseline-standard"
    }
    s1_compliant = {
      name      = volterra_http_loadbalancer.s1_compliant.name
      namespace = volterra_namespace.baseline.name
      hostname  = "app-compliant"
    }
    s1_below_baseline = {
      name      = volterra_http_loadbalancer.s1_below_baseline.name
      namespace = volterra_namespace.baseline.name
      hostname  = "app-below-baseline"
    }
    s1_above_baseline = {
      name      = volterra_http_loadbalancer.s1_above_baseline.name
      namespace = volterra_namespace.baseline.name
      hostname  = "app-above-baseline"
    }
    s2_enterprise_ready = {
      name      = volterra_http_loadbalancer.s2_enterprise_ready.name
      namespace = volterra_namespace.plan.name
      hostname  = "app-enterprise-ready"
    }
    s2_essentials_only = {
      name      = volterra_http_loadbalancer.s2_essentials_only.name
      namespace = volterra_namespace.plan.name
      hostname  = "app-essentials-only"
    }
    s2_minimal = {
      name      = volterra_http_loadbalancer.s2_minimal.name
      namespace = volterra_namespace.plan.name
      hostname  = "app-minimal"
    }
    s3_labeled_compliant = {
      name      = volterra_http_loadbalancer.s3_labeled_compliant.name
      namespace = volterra_namespace.labels.name
      hostname  = "app-labeled-compliant"
    }
    s3_partial_labels = {
      name      = volterra_http_loadbalancer.s3_partial_labels.name
      namespace = volterra_namespace.labels.name
      hostname  = "app-partial-labels"
    }
    s3_no_labels = {
      name      = volterra_http_loadbalancer.s3_no_labels.name
      namespace = volterra_namespace.labels.name
      hostname  = "app-no-labels"
    }
    s4_ecommerce = {
      name      = volterra_http_loadbalancer.s4_ecommerce.name
      namespace = volterra_namespace.workloads.name
      hostname  = "shop"
    }
    s4_partner_api = {
      name      = volterra_http_loadbalancer.s4_partner_api.name
      namespace = volterra_namespace.workloads.name
      hostname  = "api"
    }
    s4_marketing = {
      name      = volterra_http_loadbalancer.s4_marketing.name
      namespace = volterra_namespace.workloads.name
      hostname  = "www"
    }
    s4_internal = {
      name      = volterra_http_loadbalancer.s4_internal.name
      namespace = volterra_namespace.workloads.name
      hostname  = "tools"
    }
    s4_staging = {
      name      = volterra_http_loadbalancer.s4_staging.name
      namespace = volterra_namespace.workloads.name
      hostname  = "staging"
    }
  }
}

data "volterra_http_loadbalancer_state" "lbs" {
  for_each = local.all_lbs

  name      = each.value.name
  namespace = each.value.namespace
}

# --- Flatten DNS records into lists for Namecheap ---

locals {
  domain_suffix      = ".${var.namecheap_domain}"
  base_domain_prefix = trimsuffix(var.base_domain, ".${var.namecheap_domain}")

  a_records = [
    for key, state in data.volterra_http_loadbalancer_state.lbs : {
      hostname = "${local.all_lbs[key].hostname}.${local.base_domain_prefix}"
      address  = state.ip_address
    }
  ]

  acme_cname_records = flatten([
    for key, state in data.volterra_http_loadbalancer_state.lbs : [
      for record in try(state.auto_cert_info[0].dns_records, []) : {
        hostname = trimsuffix(record.name, local.domain_suffix)
        address  = record.value
      } if record.type == "CNAME"
    ]
  ])
}

# --- Create A + CNAME records in Namecheap (MERGE mode) ---

resource "namecheap_domain_records" "demo_dns" {
  domain = var.namecheap_domain
  mode   = "MERGE"

  dynamic "record" {
    for_each = local.a_records
    content {
      hostname = record.value.hostname
      type     = "A"
      address  = record.value.address
      ttl      = 300
    }
  }

  dynamic "record" {
    for_each = local.acme_cname_records
    content {
      hostname = record.value.hostname
      type     = "CNAME"
      address  = record.value.address
      ttl      = 300
    }
  }
}
