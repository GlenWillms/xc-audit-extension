# =============================================================================
# Scenario 2: Plan-Based Filtering
#
# No baseline LB references, no exemption labels. Demonstrates how switching
# between Essentials and Enterprise plans changes which checks are evaluated.
#
# Expected results:
#                         Essentials   Enterprise (+ add-ons)
#   app-enterprise-ready  PASS         PASS
#   app-essentials-only   PASS         WARN (missing enterprise features)
#   app-minimal           WARN         WARN
# =============================================================================

# -----------------------------------------------------------------------------
# app-enterprise-ready — Every feature enabled → PASS on any plan
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s2_enterprise_ready" {
  name        = "app-enterprise-ready"
  namespace   = volterra_namespace.plan.name
  description = "All security features enabled — passes on any plan"
  domains     = ["app-enterprise-ready.${var.base_domain}"]
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

  # Full WAF with AI
  app_firewall {
    name      = volterra_app_firewall.full.name
    namespace = var.shared_namespace
  }

  # Policy & Data
  service_policies_from_namespace = true
  default_sensitive_data_policy   = true

  # Core Security (Transport)
  disable_trust_client_ip_headers = true

  # API Security
  enable_api_discovery {
    disable_learn_from_redirect_traffic = true
  }

  api_specification {
    api_definition {
      name      = volterra_api_definition.httpbin.name
      namespace = var.shared_namespace
    }
    validation_disabled = true
  }

  # Bot Defense
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

  # Addons — toggled via variables (require tenant subscriptions)
  disable_client_side_defense = var.enable_client_side_defense ? null : true
  disable_malware_protection  = var.enable_malware_protection ? null : true

  dynamic "client_side_defense" {
    for_each = var.enable_client_side_defense ? [1] : []
    content {
      policy {
        js_insert_all_pages = true
      }
    }
  }

  dynamic "malware_protection_settings" {
    for_each = var.enable_malware_protection ? [1] : []
    content {
      malware_protection_rules {
        metadata {
          name = "default"
        }
        domain {
          any_domain {}
        }
        path {
          prefix = "/"
        }
        action {
          block = true
        }
      }
    }
  }

  disable_rate_limit = true
  round_robin        = true
  no_challenge       = true
  user_id_client_ip  = true

  depends_on = [volterra_active_service_policies.plan]
}

# -----------------------------------------------------------------------------
# app-essentials-only — Essentials features only → PASS on Essentials, WARN on Enterprise
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s2_essentials_only" {
  name        = "app-essentials-only"
  namespace   = volterra_namespace.plan.name
  description = "Essentials-level features only — PASS on Essentials, WARN on Enterprise"
  domains     = ["app-essentials-only.${var.base_domain}"]
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

  # Basic WAF (no AI — AI is enterprise-tier)
  app_firewall {
    name      = volterra_app_firewall.basic.name
    namespace = var.shared_namespace
  }

  # Essentials checks that pass
  service_policies_from_namespace = true
  disable_trust_client_ip_headers = true

  api_specification {
    api_definition {
      name      = volterra_api_definition.httpbin.name
      namespace = var.shared_namespace
    }
    validation_disabled = true
  }

  # Enterprise/add-on features intentionally disabled
  disable_bot_defense         = true
  disable_api_discovery       = true
  disable_client_side_defense = true
  disable_malware_protection  = true
  # No default_sensitive_data_policy (enterprise)
  # No api_testing (enterprise)

  disable_rate_limit = true
  round_robin        = true
  no_challenge       = true
  user_id_client_ip  = true

  depends_on = [volterra_active_service_policies.plan]
}

# -----------------------------------------------------------------------------
# app-minimal — HTTP only, nothing configured → WARN on any plan
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s2_minimal" {
  name        = "app-minimal"
  namespace   = volterra_namespace.plan.name
  description = "Bare minimum — HTTP only, no security features"
  domains     = ["app-minimal.${var.base_domain}"]
  advertise_on_public_default_vip = true

  http {
    dns_volterra_managed = false
    port                 = 80
  }

  default_route_pools {
    pool {
      name      = volterra_origin_pool.demo.name
      namespace = var.shared_namespace
    }
    weight   = 1
    priority = 1
  }

  # No WAF, no DDoS, no service policies, no security features at all
  disable_waf                 = true
  disable_bot_defense         = true
  disable_api_discovery       = true
  disable_api_definition      = true
  disable_client_side_defense = true
  disable_malware_protection  = true

  disable_rate_limit = true
  round_robin        = true
  no_challenge       = true
  user_id_client_ip  = true

  depends_on = [volterra_active_service_policies.plan]
}
