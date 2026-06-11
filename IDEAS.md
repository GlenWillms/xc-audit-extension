# Ideas

Parked ideas for future consideration. Not committed to — just captured so they don't get lost.

## ~~Parent vs Child Tenant Awareness~~ ✅ Implemented

Managed (child) tenants are now tracked as composite IDs (`parent::child`) throughout the extension. The tenant selector shows `parent > child` entries, each with independent settings, baselines, and branding. Reports and namespace discovery use the correct `/managed_tenant/{child}/` API prefix.

## ~~Baseline Templates from Default Namespace LBs~~ ✅ Implemented

Implemented as the **Baseline LB Override** feature. Add the label `xc-audit-baseline-lb=<name>` to an LB to compare it against a reference LB in the `default` namespace. See README for details.

## Export/Import Settings

Allow exporting the full configuration (baseline, exemption map, overrides) as a JSON file and importing it on another machine. Useful for sharing a baseline across a team.

## Audit History

Track audit results over time per namespace. Show trends — did the number of failing LBs go up or down since last week?

## Bulk Label Assignment

Add a UI to apply exemption labels to multiple LBs at once, rather than labeling each LB individually in the XC console.

## Notification on Drift

Background monitoring that periodically re-audits and sends a browser notification when an LB's compliance status changes (e.g., goes from PASS to FAIL).

## ~~Namespace-Level Summary Dashboard~~ ✅ Implemented

Implemented as the **HTML Report** feature. Click **Report** in the popup to generate a downloadable report covering all audited namespaces with executive summary, per-namespace details, and prioritized recommendations. Reports include tenant branding (logo and company name).

## CDN Load Balancer Support

Extend auditing to CDN load balancers in addition to HTTP load balancers. The xcshowmap extension already fetches CDN LB data — similar patterns could apply.

## TCP Load Balancer Support

Extend auditing to TCP load balancers with a separate baseline template.

## Custom Explanation Editor in Template Builder

Allow editing the explanation text (reason + next_step) per check directly in the visual template builder, rather than only through the raw JSON editor.

## Chrome Web Store / Edge Add-ons Publishing

Package and publish to the browser extension stores for easier distribution instead of requiring "Load unpacked".

## RBAC-Aware Auditing

Detect the user's role/permissions and adjust which checks are shown or which actions are available (e.g., read-only users can't set overrides).
