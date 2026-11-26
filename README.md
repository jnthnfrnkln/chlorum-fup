# Chlorum follow-ups

A small portal where JF shares open to-dos with his direct reports and they post status updates.

- `index.html` is the whole site (served by GitHub Pages). Each person opens it with their personal link (`#k=<token>`); the token is kept in the browser.
- `supabase/functions/equipe-portal` is the API (a Supabase Edge Function). It checks the token and only returns the items JF has shared with that person.
- `supabase/schema.sql` is the database. All data lives in Supabase with row-level security on and no public policies; nothing about the items is stored in this repository.

Updates flow back into JF's vault and the Organizer through a scheduled Claude task.
