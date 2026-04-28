# Security Notes

This document describes the current security posture of the readable parts of this repository and the operating assumptions required for safer deployment.

## Current Hardening

Recent security hardening in this branch includes:

- local proxy authentication via per-install token
- stricter permissions for proxy settings and mailbox state files
- validator sandbox path restrictions
- signed skill update enforcement by default
- `force update` disabled unless explicitly enabled
- `skills_monitor` auto-install disabled unless explicitly enabled
- argv-based git/process execution in several modules to reduce shell injection risk

## Deployment Guidance

Treat Evolver as a privileged local automation tool.

Recommended baseline:

1. Run it on a dedicated user account.
2. Keep it off shared or multi-tenant hosts.
3. Prefer offline mode unless Hub features are required.
4. If validator mode is enabled, run it inside a container or VM with network egress controls.
5. Do not enable `EVOLVE_GIT_RESET`, `EVOLVER_ENABLE_FORCE_UPDATE`, or `EVOLVER_ENABLE_SKILL_AUTO_INSTALL` unless you have a clear operational reason.

## Sensitive Flags

These flags materially increase risk and should stay off by default:

- `EVOLVE_GIT_RESET=true`
- `EVOLVER_ENABLE_FORCE_UPDATE=true`
- `EVOLVER_ENABLE_SKILL_AUTO_INSTALL=true`
- `EVOMAP_ALLOW_UNSIGNED_SKILL_UPDATE=true`
- `EVOMAP_PROXY_REQUIRE_AUTH=false`

## Remaining High-Risk Areas

The following areas still deserve deeper audit:

- validator execution isolation beyond path validation
- Hub trust model and message authenticity
- any path that can update local skills or fetch remote assets
- destructive recovery paths guarded by environment variables

## Recommended Next Steps

1. Add container-based validator isolation guidance and example configs.
2. Add signature verification for remote updates beyond skill payload hash checks.
3. Add more tests around proxy auth failures and recovery flows.
4. Add a public security reporting process and maintainer contact.
