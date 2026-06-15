# =============================================================================
# Scenario 4: Realistic Workloads — Compliance Blind Spots
#
# Each LB represents a real-world application deployed by a different team.
# They all look reasonable at a glance in the XC console, but each has
# non-obvious compliance gaps that the audit tool surfaces.
#
# No labels, no baseline refs — just raw audit results showing the value
# of automated compliance auditing.
#
# Expected results (Essentials plan):
#   ecommerce-storefront → WARN  (subtle: trust client IP, no sensitive data)
#   partner-api-gateway  → WARN  (no WAF at all despite API security)
#   marketing-site       → WARN  (WAF in monitoring mode — hardest to spot)
#   internal-tools       → WARN  (HTTP only, no security at all)
#   staging-mirror       → WARN  (drifted from production posture)
# =============================================================================

# -----------------------------------------------------------------------------
# ecommerce-storefront — "We have WAF" false confidence
#
# The team enabled WAF, DDoS, and TLS — looks solid. But:
#   - Trust Client IP Headers not disabled → IP spoofing risk
#   - No Sensitive Data Policy → PII leak risk in responses
#   - No API Specification → no request validation
# These gaps are invisible unless you audit each check individually.
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s4_ecommerce" {
  name        = "ecommerce-storefront"
  namespace   = volterra_namespace.workloads.name
  description = "E-commerce storefront — looks secure but has subtle gaps"
  domains     = ["shop.${var.base_domain}"]
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
    name      = volterra_app_firewall.full.name
    namespace = var.shared_namespace
  }

  service_policies_from_namespace = true
  # Intentionally NOT setting disable_trust_client_ip_headers
  # Intentionally NOT setting default_sensitive_data_policy

  disable_rate_limit          = true
  round_robin                 = true
  no_challenge                = true
  user_id_client_ip           = true
  disable_bot_defense         = true
  disable_api_discovery       = true
  disable_api_definition      = true
  disable_client_side_defense = true
  disable_malware_protection  = true

  depends_on = [volterra_active_service_policies.workloads]
}

# -----------------------------------------------------------------------------
# partner-api-gateway — API-layer myopia
#
# The API team invested heavily in API security: discovery, spec validation,
# JWT auth. But they assumed API controls were sufficient and skipped WAF
# entirely. SQL injection and XSS go unmitigated.
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s4_partner_api" {
  name        = "partner-api-gateway"
  namespace   = volterra_namespace.workloads.name
  description = "Partner API — strong API security, no WAF"
  domains     = ["api.${var.base_domain}"]
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

  # No WAF — the team thought API spec + JWT was enough
  disable_waf = true

  service_policies_from_namespace = true
  disable_trust_client_ip_headers = true

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

  # No DDoS protection
  disable_bot_defense         = true
  disable_client_side_defense = true
  disable_malware_protection  = true

  disable_rate_limit = true
  round_robin        = true
  no_challenge       = true
  user_id_client_ip  = true

  depends_on = [volterra_active_service_policies.workloads]
}

# -----------------------------------------------------------------------------
# marketing-site — WAF exists but isn't blocking
#
# This is the hardest blind spot to catch visually. The LB has a WAF policy
# assigned — it shows up in the console, the security tab looks populated.
# But the WAF is in MONITORING mode, not blocking. Zero enforcement.
# Without the audit tool, this passes a visual check every time.
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s4_marketing" {
  name        = "marketing-site"
  namespace   = volterra_namespace.workloads.name
  description = "Marketing site — WAF assigned but in monitoring mode"
  domains     = ["www.${var.base_domain}"]
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

  # WAF assigned but in MONITORING mode — looks secure, isn't enforcing
  app_firewall {
    name      = volterra_app_firewall.monitoring.name
    namespace = var.shared_namespace
  }

  service_policies_from_namespace = true
  # No DDoS, trust client IP not disabled

  disable_rate_limit          = true
  round_robin                 = true
  no_challenge                = true
  user_id_client_ip           = true
  disable_bot_defense         = true
  disable_api_discovery       = true
  disable_api_definition      = true
  disable_client_side_defense = true
  disable_malware_protection  = true

  depends_on = [volterra_active_service_policies.workloads]
}

# -----------------------------------------------------------------------------
# internal-tools — "It's internal, we don't need security"
#
# Deployed with HTTP only because the team assumed internal traffic doesn't
# need protection. But on F5 XC, the LB is on the public network — there
# is no "internal only." Zero security configuration.
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s4_internal" {
  name        = "internal-tools"
  namespace   = volterra_namespace.workloads.name
  description = "Internal tooling — HTTP only, no security"
  domains     = ["tools.${var.base_domain}"]
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

  depends_on = [volterra_active_service_policies.workloads]
}

# -----------------------------------------------------------------------------
# staging-mirror — Configuration drift from production
#
# Started as a clone of the production LB. Over time:
#   - WAF stayed basic (no AI) after an upgrade was skipped
#   - Trust client IP enabled for testing, never reverted
#   - Bot defense disabled for load testing, never re-enabled
#   - Sensitive data policy not enabled after the prod rollout
# Each change was "temporary." None were reverted.
# -----------------------------------------------------------------------------

resource "volterra_http_loadbalancer" "s4_staging" {
  name        = "staging-mirror"
  namespace   = volterra_namespace.workloads.name
  description = "Staging — drifted from production security posture"
  domains     = ["staging.${var.base_domain}"]
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

  # Drift: trust client IP enabled for testing, never reverted
  # (Not setting disable_trust_client_ip_headers)

  # Drift: API discovery was enabled, other features disabled for testing
  enable_api_discovery {
    disable_learn_from_redirect_traffic = true
  }

  # Drift: bot defense disabled for load testing
  disable_bot_defense         = true
  # Drift: sensitive data policy not enabled after prod rollout
  # (Not setting default_sensitive_data_policy)

  disable_api_definition      = true
  disable_client_side_defense = true
  disable_malware_protection  = true

  disable_rate_limit = true
  round_robin        = true
  no_challenge       = true
  user_id_client_ip  = true

  depends_on = [volterra_active_service_policies.workloads]
}
