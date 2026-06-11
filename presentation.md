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

- **PASS (11 passed, 1 skipped)** -- green badge, all active checks passed
- **WARNING (2 warnings, 9 passed)** -- red badge, issues found

Click the badge to expand a detail row with categorized findings.

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

Generate a downloadable report covering all audited namespaces in a tenant.

1. Visit namespace LB list pages to collect audit data
2. Click **Report** in the popup
3. Select namespaces to include, click **Generate Report**
4. Preview the report, then **Download HTML**

---

## Report Contents

- **Tenant branding** -- logo and company name fetched from the XC tenant settings API
- **Executive summary** -- compliance %, LB pass/warning counts, per-category breakdown
- **Per-namespace sections** -- service policy status + categorized LB findings
- **Recommendations** -- aggregated, deduplicated, sorted by severity then frequency, with remediation steps

Self-contained HTML with no external dependencies. Prints cleanly.

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

## Summary

| Capability | How |
|------------|-----|
| Automated compliance checks | Runs on every LB list page visit |
| 16+ security checks | TLS, WAF, DDoS, API, Bot, Policy |
| Flexible exemptions | XC labels per LB |
| Baseline LB override | Reference LB in default namespace |
| Plan tier awareness | Essentials / Enterprise / Add-on |
| Policy comparison | Auto-compare against default namespace |
| Tenant-wide HTML report | Executive summary + recommendations |
| Zero configuration auth | Uses browser session |
| Efficient | Version-based caching |

---

## Questions?
