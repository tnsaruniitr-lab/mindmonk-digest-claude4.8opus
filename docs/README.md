# 📚 Documentation

Planning, architecture, and engineering reference for the **Podcast Digest Bot**
(`mindmonk-digest-claude4.8opus`). Start here.

## Documents

### 📄 [SPEC.md](https://github.com/tnsaruniitr-lab/mindmonk-digest-claude4.8opus/blob/main/SPEC.md)
Product + implementation spec for the multi-tenant (1,000-user) target: the
shared-extraction / per-user-personalization cache model, the multi-tenant data
model, transcription & LLM cost economics, freemium tiers, and a phased roadmap.

### 🏛️ [ARCHITECTURE.md](https://github.com/tnsaruniitr-lab/mindmonk-digest-claude4.8opus/blob/main/ARCHITECTURE.md)
Three-part architecture reference:
- **Part I — Current Architecture (As-Built Today):** the single-user system + the
  3-tier transcription waterfall (Supadata → yt-dlp/Groq → OpenAI), cited to `file:line`.
- **Part II — Target Architecture (What We Will Build):** the multi-tenant design.
- **Part III — Engineering Best Practices (Reference):** durable do/don't conventions.

### 🗺️ [PHASES.md](https://github.com/tnsaruniitr-lab/mindmonk-digest-claude4.8opus/blob/main/PHASES.md)
Phased delivery plan **P0 → P3**, each with a granular checklist, UATs (user
acceptance tests), exit criteria, and rollback notes.

---

**Status:** the transcription pipeline (Architecture Part I) is built and deployed;
the multi-tenant product (Part II + SPEC + PHASES) is specified, not yet built.
