# -----------------------------------------------------------------------------
# Namespaces
# -----------------------------------------------------------------------------

resource "volterra_namespace" "baseline" {
  name        = "audit-demo-baseline"
  description = "XC Audit Demo: Baseline LB override scenario"
}

resource "volterra_namespace" "plan" {
  name        = "audit-demo-plan"
  description = "XC Audit Demo: Plan-based filtering scenario"
}

resource "volterra_namespace" "labels" {
  name        = "audit-demo-labels"
  description = "XC Audit Demo: Exemption label scenario"
}

resource "volterra_namespace" "workloads" {
  name        = "audit-demo-workloads"
  description = "XC Audit Demo: Realistic workloads with compliance blind spots"
}

# -----------------------------------------------------------------------------
# Origin Pool (shared — used by all demo LBs)
# -----------------------------------------------------------------------------

resource "volterra_origin_pool" "demo" {
  name                   = "demo-origin"
  namespace              = var.shared_namespace
  description            = "Demo origin pool pointing to httpbin.org"
  loadbalancer_algorithm = "LB_OVERRIDE"
  endpoint_selection     = "LOCAL_PREFERRED"
  port                   = 443

  origin_servers {
    public_name {
      dns_name = "httpbin.org"
    }
  }

  use_tls {
    tls_config {
      default_security = true
    }
    no_mtls              = true
    volterra_trusted_ca  = true
    skip_server_verification = true
  }
}

# -----------------------------------------------------------------------------
# API Definition (references swagger uploaded to XC object store)
# -----------------------------------------------------------------------------

resource "volterra_api_definition" "httpbin" {
  name      = "httpbin-org"
  namespace = var.shared_namespace

  swagger_specs = [
    "/api/object_store/namespaces/${var.shared_namespace}/stored_objects/swagger/httpbin-org/v1-26-06-15"
  ]
}

# -----------------------------------------------------------------------------
# App Firewalls
# -----------------------------------------------------------------------------

resource "volterra_app_firewall" "full" {
  name                     = "demo-appfw-full"
  namespace                = var.shared_namespace
  description              = "Full WAF: blocking, threat campaigns, bot blocking, AI"
  allow_all_response_codes = true
  default_anonymization    = true
  use_default_blocking_page = true
  blocking                 = true

  detection_settings {
    signature_selection_setting {
      default_attack_type_settings        = true
      high_medium_low_accuracy_signatures = true
    }
    enable_suppression      = true
    disable_staging         = true
    enable_threat_campaigns = true
    default_bot_setting     = true

    violations_view {
      name               = "VIOL_HTTP_PROTOCOL_BAD_HTTP_VERSION"
      title              = "Bad HTTP version"
      description        = "An HTTP request specifies an unsupported or unrecognized HTTP version."
      enabled_by_default = "Yes"
      enabled            = true
    }
  }

  bot_protection_setting {
    malicious_bot_action  = "BLOCK"
    suspicious_bot_action = "REPORT"
    good_bot_action       = "REPORT"
  }

  enable_ai_enhancements {
    mitigate_high_medium_risk_action = true
  }
}

resource "volterra_app_firewall" "basic" {
  name                     = "demo-appfw-basic"
  namespace                = var.shared_namespace
  description              = "Basic WAF: blocking, threat campaigns, bot blocking, NO AI"
  allow_all_response_codes = true
  default_anonymization    = true
  use_default_blocking_page = true
  blocking                 = true

  detection_settings {
    signature_selection_setting {
      default_attack_type_settings        = true
      high_medium_low_accuracy_signatures = true
    }
    enable_suppression      = true
    disable_staging         = true
    enable_threat_campaigns = true
    default_bot_setting     = true

    violations_view {
      name               = "VIOL_HTTP_PROTOCOL_BAD_HTTP_VERSION"
      title              = "Bad HTTP version"
      description        = "An HTTP request specifies an unsupported or unrecognized HTTP version."
      enabled_by_default = "Yes"
      enabled            = true
    }
  }

  bot_protection_setting {
    malicious_bot_action  = "BLOCK"
    suspicious_bot_action = "REPORT"
    good_bot_action       = "REPORT"
  }

  disable_ai_enhancements = true
}

resource "volterra_app_firewall" "monitoring" {
  name                     = "demo-appfw-monitoring"
  namespace                = var.shared_namespace
  description              = "Monitoring-only WAF (fails blocking inspector)"
  allow_all_response_codes = true
  default_anonymization    = true
  use_default_blocking_page = true
  monitoring               = true

  detection_settings {
    signature_selection_setting {
      default_attack_type_settings        = true
      high_medium_low_accuracy_signatures = true
    }
    enable_suppression      = true
    disable_staging         = true
    enable_threat_campaigns = true
    default_bot_setting     = true

    violations_view {
      name               = "VIOL_HTTP_PROTOCOL_BAD_HTTP_VERSION"
      title              = "Bad HTTP version"
      description        = "An HTTP request specifies an unsupported or unrecognized HTTP version."
      enabled_by_default = "Yes"
      enabled            = true
    }
  }

  disable_ai_enhancements = true
}

# -----------------------------------------------------------------------------
# Service Policies
# -----------------------------------------------------------------------------

resource "volterra_service_policy" "ofac_geo_block" {
  name        = "demo-ofac-geo-block"
  namespace   = var.shared_namespace
  description = "OFAC country deny list — satisfies Geo Policy inspector (RU, IR, KP)"
  algo        = "FIRST_MATCH"
  any_server  = true

  deny_list {
    country_list = [
      "COUNTRY_BY", "COUNTRY_BA", "COUNTRY_BI", "COUNTRY_CF",
      "COUNTRY_CD", "COUNTRY_CU", "COUNTRY_IR", "COUNTRY_IQ",
      "COUNTRY_KP", "COUNTRY_XK", "COUNTRY_LB", "COUNTRY_LY",
      "COUNTRY_MK", "COUNTRY_NI", "COUNTRY_RU", "COUNTRY_SO",
      "COUNTRY_SS", "COUNTRY_SD", "COUNTRY_SY", "COUNTRY_UA",
      "COUNTRY_VE", "COUNTRY_YE", "COUNTRY_ZW",
    ]
    default_action_next_policy = true
  }
}

resource "volterra_service_policy" "ip_threat_intel" {
  name        = "demo-ip-threat-intel"
  namespace   = var.shared_namespace
  description = "IP threat intelligence — satisfies IP Reputation inspector (12 categories)"
  algo        = "FIRST_MATCH"
  any_server  = true

  rule_list {
    rules {
      metadata {
        name        = "ip-threat-intel"
        description = "Deny traffic from known malicious IP categories"
        disable     = false
      }
      spec {
        action = "DENY"
        any_ip = true
        ip_threat_category_list {
          ip_threat_categories = [
            "SPAM_SOURCES",
            "WINDOWS_EXPLOITS",
            "WEB_ATTACKS",
            "BOTNETS",
            "SCANNERS",
            "REPUTATION",
            "PHISHING",
            "PROXY",
            "MOBILE_THREATS",
            "TOR_PROXY",
            "DENIAL_OF_SERVICE",
            "NETWORK",
          ]
        }
        waf_action {
          none = true
        }
      }
    }
    rules {
      metadata {
        name        = "allow-all"
        description = "Default allow rule"
        disable     = false
      }
      spec {
        action     = "ALLOW"
        any_client = true
        any_ip     = true
        waf_action {
          none = true
        }
      }
    }
  }
}

# -----------------------------------------------------------------------------
# Active Service Policies (per namespace)
# -----------------------------------------------------------------------------

resource "volterra_active_service_policies" "default" {
  namespace = "default"

  policies {
    name      = volterra_service_policy.ofac_geo_block.name
    namespace = var.shared_namespace
  }
  policies {
    name      = volterra_service_policy.ip_threat_intel.name
    namespace = var.shared_namespace
  }
  policies {
    name      = "ves-io-allow-all"
    namespace = "ves-io-shared"
  }
}

resource "volterra_active_service_policies" "baseline" {
  namespace = volterra_namespace.baseline.name

  policies {
    name      = volterra_service_policy.ofac_geo_block.name
    namespace = var.shared_namespace
  }
  policies {
    name      = volterra_service_policy.ip_threat_intel.name
    namespace = var.shared_namespace
  }
  policies {
    name      = "ves-io-allow-all"
    namespace = "ves-io-shared"
  }
}

resource "volterra_active_service_policies" "plan" {
  namespace = volterra_namespace.plan.name

  policies {
    name      = volterra_service_policy.ofac_geo_block.name
    namespace = var.shared_namespace
  }
  policies {
    name      = volterra_service_policy.ip_threat_intel.name
    namespace = var.shared_namespace
  }
  policies {
    name      = "ves-io-allow-all"
    namespace = "ves-io-shared"
  }
}

resource "volterra_active_service_policies" "labels" {
  namespace = volterra_namespace.labels.name

  policies {
    name      = volterra_service_policy.ofac_geo_block.name
    namespace = var.shared_namespace
  }
  policies {
    name      = volterra_service_policy.ip_threat_intel.name
    namespace = var.shared_namespace
  }
  policies {
    name      = "ves-io-allow-all"
    namespace = "ves-io-shared"
  }
}

resource "volterra_active_service_policies" "workloads" {
  namespace = volterra_namespace.workloads.name

  policies {
    name      = volterra_service_policy.ofac_geo_block.name
    namespace = var.shared_namespace
  }
  policies {
    name      = volterra_service_policy.ip_threat_intel.name
    namespace = var.shared_namespace
  }
  policies {
    name      = "ves-io-allow-all"
    namespace = "ves-io-shared"
  }
}
