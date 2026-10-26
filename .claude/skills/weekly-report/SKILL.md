---
name: weekly-report
description: Build the Emerald AI weekly media-intelligence report with Claude Code from the data the app collected - read every counted post, write the summary and actions, build, audit and (only when told) publish to the web app. Use when asked to build, fix or re-do a weekly/period report.
---

Follow `tools/claude-report/README.md` step by step (fetch → digest → read every post → review.json → text.json → build → publish).

Hard rules:
- Never fetch new data or spend API credit unless the user asks; the collection is the app's job.
- Never write APIdirect, Exa or other keys to disk.
- Read every post in `posts-to-review.md` before writing `review.json`; `postsRead` must be the real number.
- Figures and neutral descriptors only; every number must come from the data; label anything else `⚠ INFERENCE — not in the source data`.
- After building, check the page's summary equals `text.json`; report any difference.
- Publishing writes to the reports repo (outward-facing): do a dry run, show the name, and publish only after the user says yes.
