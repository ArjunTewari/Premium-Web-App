# Weekly report with Claude Code

The app collects the data (Exa, APIdirect, YouTube). Claude Code writes the summary, reads every counted post,
builds the report and publishes it. No Claude CLI call, no automatic review loop on the server.

The app's own run still works and still saves the collected data (`raw/CHK-….json.gz` in the reports repo) after
step 4b. If the run later stops in the summary or the audit, that saved data is what these tools use.

## One-time

```
pnpm install            # in the repo root (or set PWA_NODE_MODULES to an existing node_modules)
gh auth login           # the GitHub CLI is used to read raw/ and (only on publish) write reports/
```

## Every week

1. **Collect** — in the web app run the report for the period. When the log shows `CHECKPOINT … saved`
   the data is saved; the run may be stopped there. (Or reuse a saved collection: `node fetch.cjs list`.)
2. **Fetch** — `node fetch.cjs get <CHK-….json.gz> --out work`
3. **Read the data** — `node digest.cjs work/<CHK-….json.gz> --out work/digest`
   writes `summary-prompt.txt` (figures + FACTS lines), `posts-to-review.md` (every counted post with the words
   that matched), `audit-warnings.txt`, `evidence-pack.json`.
4. **Review the posts** — read every post in `posts-to-review.md`. A post counts only if the post itself is about
   the subject. Leave out a post that matched only on a stray word: a list of names, a link or hashtag, a general
   climate / GHG / energy post that says "emission", a newsletter that lists the keyword as one of many titles.
   Write `work/review.json`:
   ```json
   { "reviewer": "Claude Code", "postsRead": 50, "excludePosts": ["<url>", "..."], "notes": "what was left out and why" }
   ```
   If posts were left out, run `digest.cjs` again with `--review work/review.json` so the figures are the final ones.
5. **Write the text** — `work/text.json` from `summary-prompt.txt`:
   ```json
   { "exec": [ {"headline": "", "detail": "", "section_ref": "§03 AQ Press Analytics"}, ... 3 in all ],
     "actions": { "<org>": [ {"priority": "Fix Now|Invest|Optimise|Leverage", "area": "", "action": "", "rationale": ""}, ... 4 per org ] } }
   ```
   Rules: figures and neutral descriptors only (no evaluative or comparative adjectives); every number must be in the
   data; anything not in the source data is labelled `⚠ INFERENCE — not in the source data`; name only organisations
   that are in the report; say when a cell was not collected (it counts as 0 but is not a measured zero).
6. **Build** — `node build.cjs work/<CHK-….json.gz> --text work/text.json --review work/review.json --out work/report`
   Runs the rule checks for real (totals, shares, repeats, summary numbers against the data). It refuses the
   review unless `postsRead` equals the posts the report counts plus the posts left out, and the report's audit
   stamp says the review was Claude Code's, how many posts were read and how many were left out.
   After building, check that the summary in the page is the text that was written (the checker can only
   correct numbers, never reword).
7. **Publish** (only when the user says so) — `node publish.cjs work/report --subject AQ` is a dry run; add `--yes` to
   write `reports/<name>.html`, `reports/<name>.json` and the manifest entry. The name is made from the report's own
   dates and organisation count by the app's `pipeline/report-naming.js` (the app names its own runs the same way):
   `<AQ|Climt|Sust>-<Full|Snap|Bench>-<period>-<n>orgs.html`.
   - one week (7 days): week of the month it starts in + month + year — `AQ-Full-2-Oct26-21orgs.html`
     (start day 1-7 → 1, 8-14 → 2, 15-21 → 3, 22-28 → 4, 29-31 → 5)
   - whole calendar month(s): `AQ-Full-Oct26-21orgs.html`, `AQ-Full-Aug-Sep26-20orgs.html`
   - any other window is written out: `AQ-Full-14Sep-11Oct26-20orgs.html`
   - snapshot / benchmark of one organisation: the organisation replaces the count — `AQ-Snap-cstep-Aug26.html`
   The tool refuses to overwrite unless `--replace`; `--remove <old-name.html>` deletes an older copy after the new one is in.
   `rename-stored.cjs` (dry run; `--yes` = one commit, revertible) moved every report already stored to this scheme.

Keep `review.json`, `text.json` and `posts-to-review.md` with the report: they are the record of what was checked.
