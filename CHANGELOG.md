# Changelog

All notable changes to this project are documented here.

## 1.20260709.0

### Breaking changes

- Simplified the orchestra runtime around the bus-communication core.
- Removed SQLite persistence, workflow monitor/recovery modules, profile presets, and compatibility exports that no longer match the simplified runtime.
- Tightened child-agent/tool boundaries and scoped authorization.

### Added

- Added automatic bus lifecycle helpers.
- Added SQLite debug logging support.
- Added shared formatting and naming helpers.
- Added Nix flake, direnv, and devcontainer setup for reproducible development.
- Improved orchestra model-selection UX and guidance.

### Changed

- Reworked workflow and workgroup tools around explicit delegation and communication.
- Humanized and simplified README, agent docs, skill docs, and orchestration notes.
- Updated Forgejo CI and publish workflows to run through the Nix environment.

### Fixed

- Hardened lifecycle cleanup, child-agent disposal, event detail bounds, owner liveness checks, and scoped runtime cleanup.
- Restored workflow recovery access before the recovery module was removed in the runtime simplification.
- Closed regression gaps around bus delivery, replaced messages, and disposal guards.

## 1.20260626.0

### Added

- Initial public release.
