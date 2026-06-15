# =============================================================================
# Scenario 1: Baseline LB Overrides
#
# A reference LB in the default namespace defines the expected security
# posture. Production LBs reference it via the xc-audit-baseline-lb label.
#
# Expected results:
#   app-compliant      → PASS  (matches baseline; missing features excused)
#   app-below-baseline → WARN  (missing WAF that baseline requires)
#   app-above-baseline → WARN  ("not in baseline" info tags for extras)
# =============================================================================

# -----------------------------------------------------------------------------
# Baseline LB (default namespace) — Essentials-level security reference
#
# Has:  TLS/HSTS, WAF (basic), DDoS, Service Policies, Trust Client IP,
#       Sensitive Data Policy
# Lacks: Bot Defense, Client-Side Defense, API Discovery, API Spec,
#        API Testing, JWT Validation, Malware Protection
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "baseline_standard" {
  name                   = "baseline-standard"
  namespace              = "default"
  description            = "Audit demo baseline: Essentials-level reference LB"
  domains                = ["baseline-standard.${var.base_domain}"]
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
  default_sensitive_data_policy   = true

  disable_rate_limit       = true
  round_robin              = true
  no_challenge             = true
  user_id_client_ip        = true
  disable_bot_defense      = true
  disable_api_discovery    = true
  disable_api_definition   = true
  disable_client_side_defense = true
  disable_malware_protection  = true

  depends_on = [
    volterra_active_service_policies.default,
    volterra_known_label.baseline_standard,
  ]
}

# -----------------------------------------------------------------------------
# app-compliant — Matches baseline exactly → PASS
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s1_compliant" {
  name        = "app-compliant"
  namespace   = volterra_namespace.baseline.name
  description = "Matches baseline-standard exactly"
  domains     = ["app-compliant.${var.base_domain}"]
  advertise_on_public_default_vip = true

  labels = {
    "xc-audit-baseline-lb" = "baseline-standard"
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
  default_sensitive_data_policy   = true

  disable_rate_limit       = true
  round_robin              = true
  no_challenge             = true
  user_id_client_ip        = true
  disable_bot_defense      = true
  disable_api_discovery    = true
  disable_api_definition   = true
  disable_client_side_defense = true
  disable_malware_protection  = true

  depends_on = [
    volterra_http_loadbalancer.baseline_standard,
    volterra_active_service_policies.baseline,
  ]
}

# -----------------------------------------------------------------------------
# app-below-baseline — Missing WAF (baseline has it) → WARN
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s1_below_baseline" {
  name        = "app-below-baseline"
  namespace   = volterra_namespace.baseline.name
  description = "Missing WAF — falls below baseline-standard"
  domains     = ["app-below-baseline.${var.base_domain}"]
  advertise_on_public_default_vip = true

  labels = {
    "xc-audit-baseline-lb" = "baseline-standard"
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

  # No app_firewall — this is intentionally below the baseline
  disable_waf = true

  service_policies_from_namespace = true
  disable_trust_client_ip_headers = true
  default_sensitive_data_policy   = true

  disable_rate_limit       = true
  round_robin              = true
  no_challenge             = true
  user_id_client_ip        = true
  disable_bot_defense      = true
  disable_api_discovery    = true
  disable_api_definition   = true
  disable_client_side_defense = true
  disable_malware_protection  = true

  depends_on = [
    volterra_http_loadbalancer.baseline_standard,
    volterra_active_service_policies.baseline,
  ]
}

# -----------------------------------------------------------------------------
# app-above-baseline — Has extras beyond baseline → WARN ("not in baseline")
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s1_above_baseline" {
  name        = "app-above-baseline"
  namespace   = volterra_namespace.baseline.name
  description = "Exceeds baseline-standard with extra features"
  domains     = ["app-above-baseline.${var.base_domain}"]
  advertise_on_public_default_vip = true

  labels = {
    "xc-audit-baseline-lb" = "baseline-standard"
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
  default_sensitive_data_policy   = true

  # Extras beyond baseline — these will appear as "not in baseline"
  enable_api_discovery {
    disable_learn_from_redirect_traffic = true
  }

  bot_defense {
    policy {
      javascript_mode = "ASYNC_JS_WITH_NO_CACHING"
      protected_app_endpoints {
        metadata {
          name = "default"
        }
        http_methods         = ["POST"]
        undefined_flow_label = true
        any_domain           = true
        path {
          prefix = "/"
        }
        mitigation {
          flag {
            no_headers = true
          }
        }
      }
      js_insert_all_pages {}
    }
    regional_endpoint = "US"
    timeout           = 1000
  }

  disable_rate_limit       = true
  round_robin              = true
  no_challenge             = true
  user_id_client_ip        = true
  disable_api_definition   = true
  disable_client_side_defense = true
  disable_malware_protection  = true

  depends_on = [
    volterra_http_loadbalancer.baseline_standard,
    volterra_active_service_policies.baseline,
  ]
}
