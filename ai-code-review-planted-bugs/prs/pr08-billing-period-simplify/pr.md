# Simplify next billing period calculation

Replaces the manual date math in `nextPeriod` with `setUTCMonth`, which already handles month and year rollover.
