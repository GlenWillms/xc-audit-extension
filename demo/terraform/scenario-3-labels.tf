# =============================================================================
# Scenario 3: Exemption Labels
#
# All three LBs have the same base config (TLS/HSTS, basic WAF, service
# policies, trust client IP). They differ only in which xc-audit-ignore-*
# labels are applied.
#
# Expected results (Essentials plan):
#   app-labeled-compliant → PASS (all gaps exempted by labels)
#   app-partial-labels    → WARN (some exempted, api_spec + jwt still fail)
#   app-no-labels         → WARN (all gaps visible as failures)
# =============================================================================

locals {
  # Common labels config for Scenario 3 LBs
  s3_base_description = "Same base config — varies by exemption labels"
}

# -----------------------------------------------------------------------------
# app-labeled-compliant — Full label exemptions → PASS
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s3_labeled_compliant" {
  name        = "app-labeled-compliant"
  namespace   = volterra_namespace.labels.name
  description = "Full exemption labels — all gaps skipped"
  domains     = ["app-labeled-compliant.${var.base_domain}"]
  advertise_on_public_default_vip = true

  labels = {
    "xc-audit-ignore-apip" = "true"
    "xc-audit-ignore-jwt"  = "true"
    "xc-audit-ignore-bot"  = "true"
    "xc-audit-ignore-csd"  = "true"
    "xc-audit-ignore-apid" = "true"
    "xc-audit-ignore-sdp"  = "true"
    "xc-audit-ignore-mp"   = "true"
  }

  https_auto_cert {
    add_hsts      = true
    http_redirect = true
    no_mtls       = true
  }

  default_route_pools {
    pool {
      name      = volterra_origin_pool.demo.name
      namespace = var.shared_namespace
    }
    weight   = 1
    priority = 1
  }

  app_firewall {
    name      = volterra_app_firewall.basic.name
    namespace = var.shared_namespace
  }

  service_policies_from_namespace = true
  disable_trust_client_ip_headers = true

  disable_rate_limit          = true
  round_robin                 = true
  no_challenge                = true
  user_id_client_ip           = true
  disable_bot_defense         = true
  disable_api_discovery       = true
  disable_api_definition      = true
  disable_client_side_defense = true
  disable_malware_protection  = true

  depends_on = [
    volterra_active_service_policies.labels,
    volterra_known_label.exemption_values_3,
  ]
}

# -----------------------------------------------------------------------------
# app-partial-labels — Some exemptions, gaps remain → WARN
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s3_partial_labels" {
  name        = "app-partial-labels"
  namespace   = volterra_namespace.labels.name
  description = "Partial exemption labels — some gaps still fail"
  domains     = ["app-partial-labels.${var.base_domain}"]
  advertise_on_public_default_vip = true

  labels = {
    "xc-audit-ignore-bot"  = "true"
    "xc-audit-ignore-csd"  = "true"
    "xc-audit-ignore-apid" = "true"
  }

  https_auto_cert {
    add_hsts      = true
    http_redirect = true
    no_mtls       = true
  }

  default_route_pools {
    pool {
      name      = volterra_origin_pool.demo.name
      namespace = var.shared_namespace
    }
    weight   = 1
    priority = 1
  }

  app_firewall {
    name      = volterra_app_firewall.basic.name
    namespace = var.shared_namespace
  }

  service_policies_from_namespace = true
  disable_trust_client_ip_headers = true

  # Not exempted: api_specification, jwt_validation, sensitive_data, malware
  # These will show as warnings

  disable_rate_limit          = true
  round_robin                 = true
  no_challenge                = true
  user_id_client_ip           = true
  disable_bot_defense         = true
  disable_api_discovery       = true
  disable_api_definition      = true
  disable_client_side_defense = true
  disable_malware_protection  = true

  depends_on = [
    volterra_active_service_policies.labels,
    volterra_known_label.exemption_values_3,
  ]
}

# -----------------------------------------------------------------------------
# app-no-labels — No exemptions → WARN (all gaps visible)
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s3_no_labels" {
  name        = "app-no-labels"
  namespace   = volterra_namespace.labels.name
  description = "No exemption labels — all gaps are failures"
  domains     = ["app-no-labels.${var.base_domain}"]
  advertise_on_public_default_vip = true

  https_auto_cert {
    add_hsts      = true
    http_redirect = true
    no_mtls       = true
  }

  default_route_pools {
    pool {
      name      = volterra_origin_pool.demo.name
      namespace = var.shared_namespace
    }
    weight   = 1
    priority = 1
  }

  app_firewall {
    name      = volterra_app_firewall.basic.name
    namespace = var.shared_namespace
  }

  service_policies_from_namespace = true
  disable_trust_client_ip_headers = true

  disable_rate_limit          = true
  round_robin                 = true
  no_challenge                = true
  user_id_client_ip           = true
  disable_bot_defense         = true
  disable_api_discovery       = true
  disable_api_definition      = true
  disable_client_side_defense = true
  disable_malware_protection  = true

  depends_on = [volterra_active_service_policies.labels]
}
