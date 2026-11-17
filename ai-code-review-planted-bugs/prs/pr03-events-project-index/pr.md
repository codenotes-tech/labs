# Speed up the project activity feed

The project events endpoint does a sequential scan per project. Adds an index on `events (project_id, id DESC)` to match the query.
