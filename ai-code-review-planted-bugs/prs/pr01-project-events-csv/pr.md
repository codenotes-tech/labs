# Add CSV export for project events

Customers asked to download a project's activity log. Adds `GET /projects/:projectId/events.csv`, which returns the latest 10,000 events as CSV. Same query as the JSON events endpoint, larger limit.
