// Report names come from the app's own module so the Claude Code tools and the app can never disagree.
// <Subject>-Full-<period>-<n>orgs.html, e.g. AQ-Full-2-Oct26-21orgs.html (2nd week of October 2026, 21 organisations);
// <Subject>-Snap|Bench-<org>-<period>.html. The rules are written at the top of the module.
module.exports = require("../../artifacts/api-server/src/pipeline/report-naming.js");
