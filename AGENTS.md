# Project Development Guidelines & Agent Rules

## Git Commit Style Policy
- **NEVER use conventional commit prefixes**: Do not use `feat:`, `feat(...)`, `refactor:`, `refactor(...)`, `fix:`, `fix(...)`, `chore:`, `chore(...)`, `test:`, `docs:`, etc.
- **ALWAYS use natural human-tone English titles**: All commit messages must be written in clear, natural, human-tone English describing the actual work done (e.g., "Add water bucket clutching reflex to prevent fatal falls", "Upgrade dynamic DAG compiler to support complex crafting trees", "Fix shelter enclosure boundary verification").
- Write concise, descriptive commit descriptions when necessary, but ensure the title itself is always plain, natural English without robotic tag prefixes.

## Engineering Invariants
- **Ground-Truth Verification**: Live milestone verification requires independent observer evidence (e.g. external spectator observer NDJSON logs), not internal client assertions alone.
- **Safety Precedence**: Survival emergencies (lava, drowning, falling, explosive threats) take immediate preemptive priority over ongoing tasks.
