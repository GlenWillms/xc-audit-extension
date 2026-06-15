---
marp: true
theme: default
paginate: true
---

# F5 XC Namespace Audit

**Automated compliance auditing for HTTP Load Balancers**

A browser extension that overlays security audit results directly on the F5 XC console.

---

## The Problem

- F5 XC tenants can have dozens of HTTP load balancers across multiple namespaces
- Each LB has a large number of security configuration options
- No built-in way to verify all LBs follow a consistent security baseline
- Manual review is slow, error-prone, and doesn't scale

---

## The Solution

A Chrome/Edge extension that:

1. Runs automatically when you visit the LB list page
2. Compares every LB against a configurable security baseline
3. Shows **PASS/WARNING** badges inline on each LB
4. Provides detailed findings with explanations and next steps

No API keys, no external services -- uses your existing browser session.

---

## How It Works

```
Navigate to LB list page
        |
Extension detects the page and captures CSRF token
        |
Fetches all LB configs + referenced objects (WAF, service policies)
        |
Compares each LB against the baseline
        |
Injects PASS/WARNING badges inline
        |
Click a badge to expand detailed findings
```

---

## What Gets Checked

| Category | Checks |
|----------|--------|
| **Core Security** | TLS, HSTS, IP Reputation, Geo Policy, Trust Client IP |
| **WAF** | App Firewall assigned, Blocking mode, Threat Campaigns, Bot Blocking, AI Risk |
| **DDoS** | Mitigation Rules, L7 DDoS Protection |
| **Bot Defense** | Bot Defense, Client-Side Defense |
| **API Security** | API Discovery, API Definition, API Testing |
| **Policy & Data** | Service Policies, Sensitive Data Policy |

---

## Plan Tier Awareness

Checks are tagged by the XC subscription tier they require:

- **Essentials** -- always shown
- **Enterprise** -- only shown when enterprise plan is selected
- **Add-on** -- shown when the specific add-on is enabled

Checks outside the tenant's plan are grayed out, not flagged as failures.

---

## Inline Badges

Each LB on the list page gets a badge:

- **Auditing...** -- pulsing gray badge while the audit is in progress
- **PASS (11 passed, 1 skipped)** -- green badge, all active checks passed
- **WARNING (2 warnings, 9 passed)** -- red badge, issues found

Click a badge to expand a detail row with categorized findings.

---

## Detail View

Findings are grouped by category:

- **Warnings** -- security features that are missing or misconfigured
- **Passed** -- checks that met the baseline
- **Skipped** -- checks exempted via labels
- **Unavailable** -- checks outside the current plan tier

Each warning includes a human-readable explanation and a suggested next step.

---

## Extension Popup

The popup provides a summary view:

- Overall compliance status (green/red)
- Service policy comparison
- Per-LB expandable details
- **Re-Audit** button to force a fresh check
- **Report** -- generate a tenant-wide HTML report
- **Settings** -- opens configuration (auto-selects active tenant)

---

## Label-Based Exemptions

Not every LB needs every security feature. Exempt specific checks using XC labels:

| Label | Effect |
|-------|--------|
| `xc-audit-ignore-apid=true` | Skip API Discovery check |
| `xc-audit-ignore-waf=true` | Skip all WAF checks |
| `xc-audit-ignore-bot=true` | Skip Bot Defense check |
| `xc-audit-ignore-ddos=true` | Skip DDoS checks |
| ... | 11 exemption codes available |

Labels are applied directly to LB objects in the XC console.

---

## Registering Labels

Labels must be registered as "known labels" in XC before use.

The extension handles this automatically:

1. Open **Settings** in the extension
2. Click **Register Labels in XC**
3. The extension creates all label keys and values via the API

Labels are registered in the `shared` namespace so they're available everywhere.

---

## Baseline LB Override

Point an LB at a **reference LB** in the `default` namespace to customize which checks matter.

**Label:** `xc-audit-baseline-lb = baseline-enterprise`

**Logic:**
- Reference LB also missing the feature? --> **Pass** (not required)
- Reference LB has the feature but this LB doesn't? --> **Warning** (gap)

---

## Baseline LB Override -- Why?

- Define the expected security posture as a real XC object
- No JSON editing -- manage baselines using familiar XC workflows
- Different LBs can reference different baselines
- Changes to the reference LB apply to all associated LBs on next audit

The badge shows `ref: baseline-enterprise` so you know the override is active.

---

## Baseline LB Override -- Example

**Reference LB `baseline-enterprise` has:**
- WAF in blocking mode
- API Discovery enabled
- Bot Defense **disabled**

**Production LB `demo-app` references it:**
- Bot Defense disabled --> **Pass** (reference also disabled)
- API Discovery missing --> **Warning** (reference has it)
- WAF blocking mode --> **Pass** (matches reference)

---

## Service Policy Baseline

The extension automatically compares each namespace's active service policies against the `default` namespace.

- **Match** -- green tag: "Active service policies match default namespace"
- **Differ** -- blue tag: "Active service policies differ from default namespace"

Per-namespace overrides available if a namespace intentionally differs.

---

## HTML Tenant Report

Generate a downloadable report covering **all namespaces** in a tenant -- not just the ones you've visited.

1. Click **Report** in the popup
2. The extension discovers all namespaces via the XC API
3. Select which namespaces to include (all selected by default)
4. Click **Generate Report** -- unaudited namespaces are audited automatically
5. Preview the report, then **Download HTML**

A progress bar tracks auditing. If the namespace count is large (>25 or >2x already audited), the extension prompts for confirmation first.

---

## Report Contents

- **Tenant branding** -- logo and company name from the active tenant (parent or managed)
- **Executive summary** -- compliance %, LB pass/warning counts, per-category breakdown
- **Per-namespace sections** -- service policy status + categorized LB findings
- **Recommendations** -- aggregated, deduplicated, sorted by severity then frequency, with remediation steps

Self-contained HTML with no external dependencies. Prints cleanly.

---

## Managed Tenant Support

Access child tenants through a parent tenant with full support:

- **Independent identity** -- each managed tenant appears as a separate entry in the tenant selector
- **Own settings** -- baselines, exemptions, and policy overrides per managed tenant (inherits from parent by default)
- **Correct branding** -- reports use the managed tenant's logo and name, not the parent's
- **Namespace discovery** -- the report page lists namespaces for the selected managed tenant
- **Automatic detection** -- the popup auto-selects the active tenant (parent or managed) when opening Settings or Report

---

## Settings Page

- **Plan & Add-ons** -- select Essentials/Enterprise, toggle add-on checks (visible on all plans)
- **Baseline Checks** -- toggle individual checks on/off with a visual builder
- **App Firewall Policy** -- set the expected WAF policy name
- **Service Policy Overrides** -- manage per-namespace policy baselines
- **Exemption Map** -- edit label-to-check mappings
- **Register/Delete Labels** -- manage XC known labels
- **Raw JSON** -- full baseline and explanations for power users
- **Reset to Defaults** -- one-click reset

---

## Caching

The extension minimizes API calls:

- LB list is always fetched (lightweight, includes version numbers)
- Individual LB configs are only re-fetched when their version changes
- Changing the baseline or exemption map invalidates all cached results
- **Re-Audit** in the popup forces a full refresh

---

## Architecture

```
Content Script              Service Worker           Audit Engine
(runs on XC page)           (background)             (pure logic)
                                 
Detect LB list page  --->  Load baseline config
Fetch LB configs     --->  Run audit checks    --->  findDiffs()
Fetch referenced     --->  Apply exemptions    --->  runInspections()
  objects (WAF, SP)  --->  Apply baseline LB   --->  applyOverrides()
                           overrides
Inject badges  <---  Cache + return results  <---  groupByCategory()
```

---

## Installation

1. Clone the repository
2. Open `chrome://extensions` or `edge://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the folder
5. Navigate to an F5 XC HTTP Load Balancer list page

No build step, no dependencies, no API keys.

---

<!-- _class: lead -->

# Live Demo

Four scenarios deployed via Terraform across separate namespaces

---

## Demo Environment

Deployed with `terraform apply` -- fully self-contained, reproducible on any tenant.

**Shared resources** across all scenarios:
- Origin pool → httpbin.org
- 3 WAF policies (full / basic / monitoring-only)
- OFAC geo-block + IP threat intelligence service policies
- Active service policies per namespace
- `xc-audit-*` exemption labels registered in `shared` namespace

**DNS**: ACME challenge CNAMEs auto-created in Namecheap

---

## Demo: Compliance Blind Spots

**Namespace:** `audit-demo-workloads`

Five realistic workloads that *look fine* in the console. None are compliant.

| Workload | Looks Like | Hidden Gap |
|----------|-----------|------------|
| `ecommerce-storefront` | Full WAF, TLS, DDoS | Trust client IP, no sensitive data policy |
| `partner-api-gateway` | Strong API security | No WAF -- injection goes unmitigated |
| `marketing-site` | WAF assigned | WAF in **monitoring mode** -- blocks nothing |
| `internal-tools` | Deployed and running | HTTP only on a public network |
| `staging-mirror` | Near-production config | Drifted: trust-IP on, bot defense off |

> Without the tool, these pass a visual check. The audit surfaces every gap.

---

## Demo: Compliance Blind Spots -- Walkthrough

1. Navigate to `audit-demo-workloads` -- all five show **WARNING**
2. Expand `marketing-site` -- WAF exists but the **blocking mode inspector** caught it
3. Expand `partner-api-gateway` -- strong API controls, missing WAF category entirely
4. Expand `ecommerce-storefront` -- subtle gaps hidden behind a solid security posture
5. Expand `staging-mirror` -- identify the "temporary" testing changes that were never reverted
6. Expand `internal-tools` -- cascade of failures for the HTTP-only LB

**Key message:** Every one of these would pass a manual review. The tool finds what humans miss.

---

## Demo: Plan-Based Filtering

**Namespace:** `audit-demo-plan`

Same LBs, different results depending on the plan selection.

| LB | Essentials Plan | Enterprise Plan |
|----|-----------------|-----------------|
| `app-enterprise-ready` | **PASS** | **PASS** |
| `app-essentials-only` | **PASS** | **WARN** |
| `app-minimal` | **WARN** | **WARN** |

---

## Demo: Plan-Based Filtering -- Walkthrough

1. Set extension plan to **Essentials**
2. Navigate to `audit-demo-plan` -- `app-essentials-only` shows **PASS**
3. Expand it -- enterprise checks are grayed out as "Unavailable"
4. Switch plan to **Enterprise** in extension settings
5. Return to `audit-demo-plan` -- `app-essentials-only` now shows **WARN**
6. Expand it -- enterprise features (Sensitive Data, API Testing, WAF AI) now appear as active warnings

**Key message:** The audit adapts to what the tenant is licensed for. No false positives for features you haven't purchased.

---

## Demo: Exemption Labels

**Namespace:** `audit-demo-labels`

Three identical LBs. Same config. Different labels. Different results.

| LB | Labels | Result |
|----|--------|--------|
| `app-labeled-compliant` | 7 exemption labels | **PASS** (with skipped count) |
| `app-partial-labels` | 3 exemption labels | **WARN** |
| `app-no-labels` | None | **WARN** |

---

## Demo: Exemption Labels -- Walkthrough

1. Navigate to `audit-demo-labels` -- compare badge results side-by-side
2. Expand `app-labeled-compliant` -- all gaps show as **Skipped** with the label that exempted them
3. Expand `app-no-labels` -- same gaps appear as **Warnings**
4. Compare the two -- identical configs, different compliance outcomes
5. Expand `app-partial-labels` -- mix of skipped and failed checks

**Key message:** Labels give teams a governed way to accept risk. Exemptions are visible in the audit, not hidden.

---

## Demo: Baseline LB Overrides

**Namespace:** `audit-demo-baseline`

A reference LB in the `default` namespace defines the expected posture.

| LB | Relationship to Baseline | Result |
|----|--------------------------|--------|
| `app-compliant` | Matches exactly | **PASS** |
| `app-below-baseline` | Missing WAF | **WARN** |
| `app-above-baseline` | Has extras (bot defense, API discovery) | **WARN** (info) |

---

## Demo: Baseline LB Overrides -- Walkthrough

1. Navigate to `audit-demo-baseline` -- note the `ref: baseline-standard` tags
2. Expand `app-compliant` -- shows "via baseline-standard" on override tags
3. Expand `app-below-baseline` -- WAF warning because the baseline *has* WAF
4. Expand `app-above-baseline` -- "not in baseline" tags for features the baseline should include

**Key message:** The baseline is a real XC object managed through normal workflows. Changes propagate automatically on next audit.

---

## Demo: Generate Report

1. Click **Report** in the extension popup
2. Select all four demo namespaces
3. Click **Generate Report**
4. Walk through the executive summary -- compliance %, per-category breakdown
5. Show per-namespace sections with detailed findings
6. Show the recommendations section -- aggregated, deduplicated, sorted by severity

**Key message:** One-click visibility across the entire tenant. Share with stakeholders as a self-contained HTML file.

---

## Summary

| Capability | How |
|------------|-----|
| Automated compliance checks | Runs on every LB list page visit |
| 16+ security checks | TLS, WAF, DDoS, API, Bot, Policy |
| Flexible exemptions | XC labels per LB |
| Baseline LB override | Reference LB in default namespace |
| Plan tier awareness | Essentials / Enterprise / Add-on |
| Policy comparison | Auto-compare against default namespace |
| Tenant-wide HTML report | Auto-audits all namespaces with recommendations |
| Managed tenant support | Independent settings and branding per child tenant |
| Zero configuration auth | Uses browser session |
| Efficient | Version-based caching |

---

## Questions?
