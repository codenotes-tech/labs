# Log signup payloads to debug failed signups

Some signups fail validation and we can't tell what clients sent. This logs the incoming payload before validation. The logger already redacts sensitive fields.
