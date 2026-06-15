# Security Hardening and Visibility Recommendations for F5 Distributed Cloud

## Tenant Level Settings

- Configure the [password policy](https://docs.cloud.f5.com/docs/how-to/user-mgmt/general-management#configure-tenant-settings) to match your organization's password policy.

- Enable mandatory tenant level, Two-Factor Authentication under Administration -> Login Options -> Enforce Two-Factor Authentication

- [Enable SSO](https://docs.cloud.f5.com/docs/how-to/user-mgmt)

  - Note: If you require a break glass tenant owner account, create that account prior to enabling SSO. SSO linked tenant owner accounts will have XC specific passwords and will follow the password policy of the tenant.

- Configure the [Global Log Receiver](https://docs.cloud.f5.com/docs/how-to/others/global-log-streaming) to capture, and archive security events and audit logs.

- Leverage groups, namespaces, and RBAC to implement a least privileges security model.

- Advanced: Restrict access to your console by enabling [Tenant Access Restrictions](https://docs.cloud.f5.com/docs/how-to/user-mgmt/general-management#enable-tenant-access-restriction) to specific IP/ASN/Region

## WAAP For Regional Edge Deployments

### Service Policies

- Define and apply [Service Policies](https://docs.cloud.f5.com/docs/how-to/app-security/service-policy) to a namespace to restrict IP Threat Categories, ASNs, and countries that don't need to have access to your applications.

- Enable IP Threat Intelligence Categories within your service policies to block traffic from known malicious sources (Spam Sources, Botnets, Anonymous Proxies, Phishing, TOR Proxies, etc.). A comprehensive policy should include all available threat categories.

- Configure geo-blocking rules within service policies to deny traffic from countries that should not have access to your applications. At minimum, consider blocking sanctioned countries (e.g., Russia, Iran, North Korea) unless business requirements dictate otherwise.

- For Dev/Test resources, use [service policies](https://docs.cloud.f5.com/docs/how-to/app-security/service-policy) to lock down to authorized testing IP address ranges, ASNs, or countries.

### Load Balancer

#### Transport Security

- Use HTTPS with TLS Security Level High

- Enable HTTP Redirect to HTTPS.

- Add HSTS Header to prevent HTTP fallback, and DNS/Man in the Middle attacks.

- Disable Trust Client IP Headers to prevent IP address spoofing. When enabled, attackers can forge `X-Forwarded-For` headers to bypass geo-blocking, IP reputation, and rate limiting controls. Only enable this setting when the load balancer sits behind a trusted upstream proxy whose headers you explicitly control.

- Manage certificate lifecycle: monitor certificate expiry dates, configure alerts for upcoming expirations, and prefer auto-cert where possible to eliminate manual renewal risk.

#### Web Application Firewall (WAF)

- Enable the [Web Application Firewall (WAF)](https://docs.cloud.f5.com/docs/ves-concepts/security#application-firewall) in blocking mode with the Default policy or better. There are High risk attack types in the Low accuracy rule category. Moving from the default of High, and Medium to a full High, Medium, and Low policy will provide the best protection with the added risk of increased false positives.

  - Note: Currently, many SQL Injection signatures are in the low accuracy grouping.

- Enable [Threat Campaign](https://docs.cloud.f5.com/docs/how-to/app-security/threat-campaigns) detection in the app firewall policy. Threat campaigns are curated signature sets targeting actively exploited vulnerabilities and coordinated attack patterns. This is a separate toggle from the base WAF signatures and must be explicitly enabled.

- Configure the WAF's built-in bot protection to block malicious bots. Set the malicious bot action to Block using either the default bot setting or a custom bot protection policy. This provides baseline bot protection at no additional cost, independent of the Bot Defense add-on.

- Enable [AI Risk Mitigation](https://docs.cloud.f5.com/docs/how-to/app-security/ai-enhancements)* in the app firewall policy. AI-powered risk scoring uses machine learning to detect and mitigate high and medium risk threats that signature-based detection may miss.

#### Cookie & Session Protection

- Configure [Cookie Protection](https://docs.cloud.f5.com/docs/how-to/app-networking/http-load-balancer) features to match your application's security needs

- Enable and test Cross-Site Request Forgery Protection

#### DDoS Protection

- Enable [DDoS Detection and Auto Mitigation](https://docs.cloud.f5.com/docs/how-to/app-security/ddos-tsa-detection)

- Configure DDoS mitigation rules with appropriate thresholds and actions for volumetric attack protection.

- Enable Layer 7 DDoS protection to detect and mitigate application-layer flood attacks using request rate analysis.

- Enable [Rate Limiting](https://docs.cloud.f5.com/docs/how-to/advanced-security/user-rate-limit)* to prevent aggressive Layer 7 DDoS behaviour, to protect API endpoints, or enforce API consumption rules.

#### Data Protection

- Configure a [Sensitive Data Policy](https://docs.cloud.f5.com/docs/how-to/app-security/sensitive-data)* to mask or block exposure of PII, credentials, and other sensitive data in responses. This prevents accidental data leakage such as credit card numbers, social security numbers, or API keys appearing in error messages or debug output.

- Enable [Malware Protection](https://docs.cloud.f5.com/docs/how-to/app-security/malware-protection)* to scan uploaded files for malicious content and block infected file uploads. This is critical for any application that accepts file uploads from users.

#### Bot & Client-Side Protection

- Prevent automated traffic and credential stuffing with [Bot Defense](https://docs.cloud.f5.com/docs/how-to/advanced-security/bot-defense)*

- Enable [Client-Side Defense](https://docs.cloud.f5.com/docs/how-to/advanced-security/csd)* to protect against client-side JavaScript attacks (Magecart, formjacking, supply chain attacks).

  - Exercise caution and test if used with F5 Bot Defense. Client-Side defense may block Bot Defense's JavaScript from executing.

#### User & Identity Protection

- Enable [Malicious User Detection](https://docs.cloud.f5.com/docs/how-to/advanced-security/malicious-users)*, User Identification Policy, and Malicious User Mitigation Settings

- Configure [JWT Validation](https://docs.cloud.f5.com/docs/how-to/app-security/jwt-validation) to verify JSON Web Tokens on incoming requests. This enforces authentication at the load balancer and blocks unauthorized access before requests reach origin servers. Particularly important for API-serving load balancers.

#### API Security

- For API publishing, move to a positive security policy and apply a known [OpenAPI/Swagger](https://docs.cloud.f5.com/docs/how-to/advanced-security/import-swagger-control-api-access) definition file to validate requests against the API specification and block malformed or unexpected calls.

- Enable [API Discovery](https://docs.cloud.f5.com/docs/how-to/app-security/apiep-discovery-control)* to identify URI paths, sensitive data, PII, and map out your URI/API path structure. Use discovery results to identify shadow or undocumented APIs that may lack security controls.

- Enable [API Testing](https://docs.cloud.f5.com/docs/how-to/app-security/api-testing)* to run automated security scans against discovered API endpoints and identify vulnerabilities before attackers do.

- Further Reading: [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html), [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)

#### Additional LB Settings

- Apply Namespace or specific [Service Policies](https://docs.cloud.f5.com/docs/how-to/app-security/service-policy) as required.

- Configure a CORS Policy to lock down web resources.

  - Note: CORS can be complex to implement, and misconfigurations could increase your security risk

- Additional Resources:

  - [OWASP Top 10 recommendations for secure applications](https://owasp.org/www-project-top-ten/)

  - [F5 Webinar on OWASP Top 10](https://www.f5.com/company/events/webinars/owasp-top-10-the-new-risk-order)

### Origin Pools

- Lock down your Origin Servers to be only accessible to [F5XC Network Ranges](https://docs.cloud.f5.com/docs/reference/network-cloud-ref).

- Use HTTPS with TLS Security Level High, where possible.

  - Observability can be used to continuously monitor your Origin Servers TLS security levels and provide a score. For locked down Origin Servers, use F5 Distributed Cloud as your External Source.

- Configure [mTLS authentication](https://docs.cloud.f5.com/docs/how-to/app-networking/origin-pools) between F5XC and your Origin Servers

  Or

- Inject a shared secret HTTP Header and configure Origin Server to deny requests without the shared secret.

- Configure origin health checks to detect unavailable or compromised origin servers. Health check failures should trigger alerts and automatic removal of unhealthy origins from the pool.

### Exemption & Exception Process

When a hardening recommendation cannot be applied to a specific load balancer (e.g., an internal-only LB that doesn't require Bot Defense, or a legacy application incompatible with HSTS), document the exception with:

- The specific recommendation being exempted
- Business or technical justification
- Compensating controls in place
- Review date for re-evaluation

In F5 XC, label-based exemptions (e.g., `xc-audit-ignore-bot: true`) can be applied to individual load balancers to document approved exceptions in the configuration itself. All exemptions should be reviewed on a regular cadence.

\* Additional licensing fees may apply. Please speak to your F5 Account Team if you have any questions.

## Licensing Tiers Reference

| Feature | Plan Tier |
|---------|-----------|
| TLS / HSTS / HTTP Redirect | Essentials |
| WAF (Blocking Mode, Threat Campaigns, Bot Blocking) | Essentials |
| Service Policies (Geo, IP Rep) | Essentials |
| DDoS Mitigation & L7 DDoS Protection | Essentials |
| CORS, Cookie Protection, CSRF | Essentials |
| JWT Validation | Essentials |
| API Definition (OpenAPI) | Essentials |
| Sensitive Data Policy | Enterprise |
| AI Risk Mitigation | Enterprise |
| Malware Protection | Enterprise |
| API Testing | Enterprise |
| Rate Limiting | Enterprise* |
| Malicious User Detection | Enterprise* |
| API Discovery | Enterprise Add-on |
| Client-Side Defense | Enterprise Add-on |
| Bot Defense | Add-on |

\* Please verify current licensing requirements with your F5 Account Team as tier availability may change.

## Alerting and Automated Reporting

- Configure [alerting policy](https://docs.cloud.f5.com/docs/reference/alert-ref) and attach an [alert receiver](https://docs.cloud.f5.com/docs/how-to/alerting)

- Configure scheduled [WAAP reports](https://docs.cloud.f5.com/docs/how-to/others/reports) and deliver on a regular schedule to WAAP admins, and Security Analysts

- Configure the [Global Log Receiver](https://docs.cloud.f5.com/docs/how-to/others/global-log-streaming) to ship logs to an external log retention system or SIEM

## Observability

- Configure external [Observability](https://docs.cloud.f5.com/docs/services/app-stack/observability) to monitor the availability of your applications.
