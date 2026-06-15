output "namespaces" {
  description = "Demo namespaces to visit in the XC console"
  value = {
    scenario_1 = volterra_namespace.baseline.name
    scenario_2 = volterra_namespace.plan.name
    scenario_3 = volterra_namespace.labels.name
    scenario_4 = volterra_namespace.workloads.name
  }
}

output "scenario_1_lbs" {
  description = "Scenario 1: Baseline LB override demo"
  value = {
    baseline_lb    = volterra_http_loadbalancer.baseline_standard.name
    compliant      = volterra_http_loadbalancer.s1_compliant.name
    below_baseline = volterra_http_loadbalancer.s1_below_baseline.name
    above_baseline = volterra_http_loadbalancer.s1_above_baseline.name
  }
}

output "scenario_2_lbs" {
  description = "Scenario 2: Plan-based filtering demo"
  value = {
    enterprise_ready = volterra_http_loadbalancer.s2_enterprise_ready.name
    essentials_only  = volterra_http_loadbalancer.s2_essentials_only.name
    minimal          = volterra_http_loadbalancer.s2_minimal.name
  }
}

output "scenario_3_lbs" {
  description = "Scenario 3: Exemption label demo"
  value = {
    labeled_compliant = volterra_http_loadbalancer.s3_labeled_compliant.name
    partial_labels    = volterra_http_loadbalancer.s3_partial_labels.name
    no_labels         = volterra_http_loadbalancer.s3_no_labels.name
  }
}

output "scenario_4_lbs" {
  description = "Scenario 4: Realistic workloads with compliance blind spots"
  value = {
    ecommerce   = volterra_http_loadbalancer.s4_ecommerce.name
    partner_api = volterra_http_loadbalancer.s4_partner_api.name
    marketing   = volterra_http_loadbalancer.s4_marketing.name
    internal    = volterra_http_loadbalancer.s4_internal.name
    staging     = volterra_http_loadbalancer.s4_staging.name
  }
}

output "shared_resources" {
  description = "Shared resources created across all scenarios"
  value = {
    origin_pool     = volterra_origin_pool.demo.name
    appfw_full      = volterra_app_firewall.full.name
    appfw_basic     = volterra_app_firewall.basic.name
    appfw_monitoring = volterra_app_firewall.monitoring.name
    policy_geo      = volterra_service_policy.ofac_geo_block.name
    policy_ip       = volterra_service_policy.ip_threat_intel.name
  }
}
