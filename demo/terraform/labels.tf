# -----------------------------------------------------------------------------
# Known Label Keys — register xc-audit exemption labels in shared namespace
#
# The XC API rate-limits known_label_key creation to 5 burst / 20 per minute.
# Labels are split into batches with time_sleep between them.
# -----------------------------------------------------------------------------

locals {
  label_batch_1 = {
    "ignore-tls"     = "XC Audit: Exempt from TLS check"
    "ignore-hsts"    = "XC Audit: Exempt from HSTS check"
    "ignore-iprep"   = "XC Audit: Exempt from IP Reputation check"
    "ignore-trustip" = "XC Audit: Exempt from Trust Client IP check"
    "ignore-geo"     = "XC Audit: Exempt from Geo Policy check"
  }
  label_batch_2 = {
    "ignore-waf"  = "XC Audit: Exempt from WAF checks"
    "ignore-ddos" = "XC Audit: Exempt from DDoS checks"
    "ignore-bot"  = "XC Audit: Exempt from Bot Defense check"
    "ignore-csd"  = "XC Audit: Exempt from Client-Side Defense check"
    "ignore-apid" = "XC Audit: Exempt from API Discovery check"
  }
  label_batch_3 = {
    "ignore-apip" = "XC Audit: Exempt from API Protection checks"
    "ignore-sp"   = "XC Audit: Exempt from Service Policies check"
    "ignore-sdp"  = "XC Audit: Exempt from Sensitive Data Policy check"
    "ignore-jwt"  = "XC Audit: Exempt from JWT Validation check"
    "ignore-mp"   = "XC Audit: Exempt from Malware Protection check"
  }

  all_exemption_labels = merge(local.label_batch_1, local.label_batch_2, local.label_batch_3)
}

# --- Batch 1 ---

resource "volterra_known_label_key" "batch_1" {
  for_each = local.label_batch_1

  key         = "xc-audit-${each.key}"
  namespace   = var.shared_namespace
  description = each.value
}

resource "time_sleep" "after_batch_1" {
  create_duration = "60s"
  depends_on      = [volterra_known_label_key.batch_1]
}

# --- Batch 2 ---

resource "volterra_known_label_key" "batch_2" {
  for_each = local.label_batch_2

  key         = "xc-audit-${each.key}"
  namespace   = var.shared_namespace
  description = each.value

  depends_on = [time_sleep.after_batch_1]
}

resource "time_sleep" "after_batch_2" {
  create_duration = "60s"
  depends_on      = [volterra_known_label_key.batch_2]
}

# --- Batch 3 ---

resource "volterra_known_label_key" "batch_3" {
  for_each = local.label_batch_3

  key         = "xc-audit-${each.key}"
  namespace   = var.shared_namespace
  description = each.value

  depends_on = [time_sleep.after_batch_2]
}

resource "time_sleep" "after_batch_3" {
  create_duration = "60s"
  depends_on      = [volterra_known_label_key.batch_3]
}

# --- Label Values (after all keys are created) ---

resource "volterra_known_label" "exemption_values_1" {
  for_each = local.label_batch_1

  key       = volterra_known_label_key.batch_1[each.key].key
  namespace = var.shared_namespace
  value     = "true"

  depends_on = [time_sleep.after_batch_3]
}

resource "time_sleep" "after_values_1" {
  create_duration = "60s"
  depends_on      = [volterra_known_label.exemption_values_1]
}

resource "volterra_known_label" "exemption_values_2" {
  for_each = local.label_batch_2

  key       = volterra_known_label_key.batch_2[each.key].key
  namespace = var.shared_namespace
  value     = "true"

  depends_on = [time_sleep.after_values_1]
}

resource "time_sleep" "after_values_2" {
  create_duration = "60s"
  depends_on      = [volterra_known_label.exemption_values_2]
}

resource "volterra_known_label" "exemption_values_3" {
  for_each = local.label_batch_3

  key       = volterra_known_label_key.batch_3[each.key].key
  namespace = var.shared_namespace
  value     = "true"

  depends_on = [time_sleep.after_values_2]
}

# --- Baseline LB reference label ---

resource "volterra_known_label_key" "baseline_lb" {
  key         = "xc-audit-baseline-lb"
  namespace   = var.shared_namespace
  description = "XC Audit: Reference baseline load balancer name"

  depends_on = [time_sleep.after_values_2]
}

resource "volterra_known_label" "baseline_standard" {
  key       = volterra_known_label_key.baseline_lb.key
  namespace = var.shared_namespace
  value     = "baseline-standard"

  depends_on = [volterra_known_label_key.baseline_lb]
}
