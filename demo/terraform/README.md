# XC Audit Extension — Terraform Demo Environment

Terraform configuration that deploys three demo scenarios to an F5 Distributed Cloud tenant, each showcasing a different compliance auditing capability of the XC Audit browser extension.

## Prerequisites

- Terraform >= 1.3
- F5 XC tenant with an API certificate (P12) — generate one in **Administration > Credentials**
- The XC Audit Extension loaded in your browser
- Permissions to create namespaces, LBs, WAF policies, service policies, and labels

## Quick Start

```bash
cd demo/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your API credentials and tenant details
terraform init
terraform plan
terraform apply
```

After `apply` completes, navigate to each demo namespace in the XC console with the extension active.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  shared namespace                                                    │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────┐  │
│  │ demo-origin  │  │ demo-appfw-full  │  │ demo-ofac-geo-block   │  │
│  │ (httpbin.org)│  │ demo-appfw-basic │  │ demo-ip-threat-intel  │  │
│  │              │  │ demo-appfw-mon.  │  │                       │  │
│  └──────────────┘  └──────────────────┘  └───────────────────────┘  │
│  + xc-audit-* known label keys                                      │
└─────────────────────────────────────────────────────────────────────┘

┌───────────────────────┐  ┌───────────────────┐  ┌────────────────────┐
│ default namespace     │  │ audit-demo-plan   │  │ audit-demo-labels  │
│ ┌───────────────────┐ │  │ ┌───────────────┐ │  │ ┌────────────────┐ │
│ │ baseline-standard │ │  │ │ enterprise-   │ │  │ │ labeled-       │ │
│ │ (reference LB)    │ │  │ │ ready         │ │  │ │ compliant      │ │
│ └───────────────────┘ │  │ ├───────────────┤ │  │ ├────────────────┤ │
└───────────────────────┘  │ │ essentials-   │ │  │ │ partial-       │ │
                           │ │ only          │ │  │ │ labels         │ │
┌───────────────────────┐  │ ├───────────────┤ │  │ ├────────────────┤ │
│ audit-demo-baseline   │  │ │ minimal       │ │  │ │ no-labels      │ │
│ ┌───────────────────┐ │  │ └───────────────┘ │  │ └────────────────┘ │
│ │ app-compliant     │ │  └───────────────────┘  └────────────────────┘
│ ├───────────────────┤ │
│ │ app-below-baseline│ │  ┌───────────────────────┐
│ ├───────────────────┤ │  │ audit-demo-workloads  │
│ │ app-above-baseline│ │  │ ┌───────────────────┐ │
│ └───────────────────┘ │  │ │ ecommerce-store.  │ │
└───────────────────────┘  │ ├───────────────────┤ │
                           │ │ partner-api-gw    │ │
                           │ ├───────────────────┤ │
                           │ │ marketing-site    │ │
                           │ ├───────────────────┤ │
                           │ │ internal-tools    │ │
                           │ ├───────────────────┤ │
                           │ │ staging-mirror    │ │
                           │ └───────────────────┘ │
                           └───────────────────────┘
```

## Scenarios

### Scenario 1: Baseline LB Overrides (`audit-demo-baseline`)

Demonstrates how a reference LB in the `default` namespace defines the expected security posture for a group of production LBs.

The **baseline-standard** LB has Essentials-level security (TLS, WAF, DDoS, service policies) but intentionally lacks Bot Defense, API Security, and other advanced features.

| LB | Configuration | Expected Result | What It Demonstrates |
|----|---------------|-----------------|----------------------|
| `app-compliant` | Matches baseline exactly | **PASS** | Missing features excused because baseline also lacks them |
| `app-below-baseline` | No WAF (baseline has WAF) | **WARN** | Below the reference — baseline passes WAF but this LB doesn't |
| `app-above-baseline` | Baseline + bot defense, API discovery | **WARN** (info) | "Not in baseline" tags flag features the baseline should include |

**How to demo:**
1. Navigate to the `audit-demo-baseline` namespace LB list
2. Note the `ref: baseline-standard` tag on each LB badge
3. Expand `app-compliant` to see override tags ("via baseline-standard")
4. Expand `app-below-baseline` to see the WAF warning
5. Expand `app-above-baseline` to see "not in baseline" informational tags

### Scenario 2: Plan-Based Filtering (`audit-demo-plan`)

Demonstrates how switching between the Essentials and Enterprise plans changes which checks are evaluated.

| LB | Configuration | Essentials Plan | Enterprise Plan (+ add-ons) |
|----|---------------|-----------------|-----------------------------|
| `app-enterprise-ready` | All features, full WAF | **PASS** | **PASS** |
| `app-essentials-only` | Essentials features, basic WAF | **PASS** | **WARN** (missing enterprise features) |
| `app-minimal` | HTTP only, no security | **WARN** | **WARN** |

**How to demo:**
1. Navigate to the `audit-demo-plan` namespace LB list
2. Open extension settings and set plan to **Essentials**
3. Note `app-essentials-only` shows PASS (enterprise checks grayed out)
4. Switch plan to **Enterprise** and enable all add-ons
5. Note `app-essentials-only` now shows WARN (enterprise features are active warnings)
6. `app-minimal` always fails because it lacks even basic TLS

### Scenario 3: Exemption Labels (`audit-demo-labels`)

Demonstrates how `xc-audit-ignore-*` labels selectively skip checks to achieve compliance without deploying every feature.

All three LBs have identical base config: HTTPS/HSTS, basic WAF, DDoS, service policies, trust client IP. They differ only in labels.

| LB | Labels Applied | Expected Result | What It Demonstrates |
|----|---------------|-----------------|----------------------|
| `app-labeled-compliant` | `ignore-apip`, `ignore-jwt`, `ignore-bot`, `ignore-csd`, `ignore-apid`, `ignore-sdp`, `ignore-mp` | **PASS** (with skipped count) | All gaps exempted by labels |
| `app-partial-labels` | `ignore-bot`, `ignore-csd`, `ignore-apid` | **WARN** | Some exempted; `api_spec` and `jwt` still fail |
| `app-no-labels` | None | **WARN** | All gaps visible as failures |

**How to demo:**
1. Navigate to the `audit-demo-labels` namespace LB list
2. Compare badge results side-by-side
3. Expand `app-labeled-compliant` to see "Skipped" items with label attribution
4. Compare with `app-no-labels` to see the same gaps as full failures
5. Note the skipped count difference in the badge text

### Scenario 4: Realistic Workloads — Compliance Blind Spots (`audit-demo-workloads`)

Five workloads that look reasonable at a glance in the XC console but each have non-obvious compliance gaps. This scenario demonstrates **why automated auditing matters** — these blind spots are invisible without the tool.

| LB | What It Has | What's Missing | Blind Spot |
|----|------------|---------------|------------|
| `ecommerce-storefront` | HTTPS/HSTS, full WAF, service policies | Trust client IP not disabled, no sensitive data policy, no API spec | "We have WAF" confidence masks IP spoofing and data exposure risks |
| `partner-api-gateway` | HTTPS/HSTS, API discovery, API spec, JWT, service policies | No WAF, no DDoS | API-layer focus; SQL injection and XSS go unmitigated |
| `marketing-site` | HTTPS/HSTS, WAF **in monitoring mode**, service policies | WAF not enforcing, no DDoS, trust client IP | WAF shows up in the console but blocks nothing — hardest gap to spot |
| `internal-tools` | HTTP only (port 80) | Everything | "It's internal" assumption on a public XC network |
| `staging-mirror` | HTTPS/HSTS, basic WAF, service policies, API discovery | Trust client IP enabled, bot defense off, no sensitive data | Drifted from production during maintenance — never reverted |

**How to demo:**
1. Navigate to the `audit-demo-workloads` namespace LB list
2. Set extension plan to **Essentials**
3. Point out: all five LBs show **WARN** — none are compliant
4. Walk through each workload and its specific blind spot:
   - `ecommerce-storefront`: Expand to show the subtle trust-client-IP and sensitive-data gaps hiding behind a solid WAF
   - `partner-api-gateway`: Show that strong API controls don't cover the WAF layer
   - `marketing-site`: Highlight that the WAF **exists** but the blocking-mode inspector catches that it's only monitoring
   - `internal-tools`: Show the cascade of failures for an HTTP-only LB
   - `staging-mirror`: Identify the drift items that were "temporary" testing changes
5. Generate a report to see all five workloads with findings in a single view

## Shared Resources

| Resource | Name | Namespace | Purpose |
|----------|------|-----------|---------|
| Origin Pool | `demo-origin` | shared | httpbin.org backend for all LBs |
| App Firewall | `demo-appfw-full` | shared | Blocking + threat campaigns + bot blocking + AI |
| App Firewall | `demo-appfw-basic` | shared | Blocking + threat campaigns + bot blocking (no AI) |
| App Firewall | `demo-appfw-monitoring` | shared | Monitoring only (intentionally fails blocking check) |
| Service Policy | `demo-ofac-geo-block` | shared | OFAC country deny list (RU, IR, KP + others) |
| Service Policy | `demo-ip-threat-intel` | shared | 12 IP threat categories |
| Active Policies | — | all namespaces | Both policies activated per namespace |
| Known Labels | `xc-audit-ignore-*` | shared | 15 exemption label keys + baseline-lb key |

## Extension Settings for Demo

Configure the extension for each scenario:

| Setting | Scenario 1 | Scenario 2 | Scenario 3 | Scenario 4 |
|---------|-----------|-----------|-----------|-----------|
| **Plan** | Essentials | Toggle between plans | Essentials | Essentials |
| **Add-ons** | None | Enable all for Enterprise demo | None | None |
| **Baseline** | Automatic (via labels) | N/A | N/A | N/A |

## Cleanup

```bash
terraform destroy
```

This removes all created resources including the baseline LB in the `default` namespace. Namespaces are also destroyed.

> **Note:** If the `default` namespace already had active service policies, `terraform destroy` will remove the demo policies. Re-apply your original policies if needed.

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| LBs show "Auditing..." but never finish | CSRF token not captured | Refresh the XC console page |
| Geo Policy / IP Reputation inspectors fail | Active service policies not set | Verify policies are active in the namespace |
| Labels not recognized | Known label keys missing | Check `shared` namespace for `xc-audit-*` keys |
| `terraform apply` rate limited | Too many parallel API calls | Re-run with `terraform apply -parallelism=2` |
| Active service policies conflict | Namespace already has policies | Import existing: `terraform import volterra_active_service_policies.X namespace_name` |
| Bot defense block errors | Provider schema mismatch | See provider docs for your version; adjust `bot_defense` block |
