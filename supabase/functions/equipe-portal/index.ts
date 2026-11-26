// Equipe portal API. One POST endpoint; every call carries the viewer's
// personal link token. A token maps to one person; admins (JF) see all.
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const REPORT_STATUSES = ["in_progress", "blocked", "needs_jf", "done_proposed"];
const ADMIN_STATUSES = ["open", "in_progress", "blocked", "needs_jf", "done_proposed", "done", "dropped"];

async function itemsWithUpdates(where: any, admin: boolean) {
  const items = await where;
  if (!items.length) return [];
  const ids = items.map((i: any) => i.id);
  const ups = await sql`
    select id, item_id, author, body, status, summary_en, created_at
    from equipe.updates where item_id in ${sql(ids)} order by created_at`;
  const by: Record<string, unknown[]> = {};
  for (const u of ups) (by[u.item_id] ??= []).push(u);
  return items.map((i: any) => {
    const out: Record<string, unknown> = { ...i, updates: by[i.id] ?? [] };
    if (!admin) { delete out.vault_text; delete out.source_link; delete out.jf_unread; }
    return out;
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const token = String(body.token ?? "");
  if (!/^[0-9a-f]{48}$/.test(token)) return json({ error: "bad_token" }, 401);
  const [me] = await sql`select slug, name, role, lang, is_admin from equipe.people where token = ${token}`;
  if (!me) return json({ error: "bad_token" }, 401);
  await sql`update equipe.people set last_seen_at = now() where slug = ${me.slug}`;
  const admin = me.is_admin as boolean;
  const action = String(body.action ?? "");

  try {
    // ---------- shared by both roles ----------
    if (action === "me") return json({ me: { slug: me.slug, name: me.name, role: me.role, lang: me.lang, admin } });

    // ---------- direct report ----------
    if (!admin) {
      if (action === "list") {
        const items = await itemsWithUpdates(sql`
          select id, title, title_local, status, due, shared_at, last_update_at, report_unread, created_at
          from equipe.items
          where person_slug = ${me.slug} and shared and status not in ('dropped','gone_from_vault')
          order by (status = 'done') asc, coalesce(last_update_at, shared_at) desc`, false);
        await sql`update equipe.items set report_unread = false where person_slug = ${me.slug} and shared and report_unread`;
        return json({ items });
      }
      if (action === "post") {
        const text = String(body.body ?? "").trim();
        const status = body.status ? String(body.status) : null;
        if (!text || text.length > 8000) return json({ error: "bad_body" }, 400);
        if (status && !REPORT_STATUSES.includes(status)) return json({ error: "bad_status" }, 400);
        const [it] = await sql`select id, status from equipe.items where id = ${String(body.item_id)}::uuid and person_slug = ${me.slug} and shared`;
        if (!it) return json({ error: "not_found" }, 404);
        if (it.status === "done") return json({ error: "closed" }, 409);
        await sql`insert into equipe.updates (item_id, author, body, status) values (${it.id}, 'report', ${text}, ${status})`;
        await sql`update equipe.items set last_update_at = now(), jf_unread = true, updated_at = now(),
                  status = coalesce(${status}, case when status = 'open' then 'in_progress' else status end)
                  where id = ${it.id}`;
        return json({ ok: true });
      }
      return json({ error: "unknown_action" }, 400);
    }

    // ---------- JF (admin) ----------
    if (action === "admin_list") {
      const people = await sql`
        select p.slug, p.name, p.role, p.lang, p.email, p.last_seen_at,
          count(i.*) filter (where i.status not in ('done','dropped','gone_from_vault'))::int as open_count,
          count(i.*) filter (where i.shared and i.status not in ('done','dropped','gone_from_vault'))::int as shared_count,
          count(i.*) filter (where i.jf_unread)::int as unread_count
        from equipe.people p left join equipe.items i on i.person_slug = p.slug
        where not p.is_admin group by p.slug order by p.name`;
      const items = await itemsWithUpdates(sql`
        select id, person_slug, vault_text, source_link, title, title_local, shared, shared_at, status, due,
               last_update_at, jf_unread, created_at
        from equipe.items where status not in ('gone_from_vault')
        order by jf_unread desc, shared desc, coalesce(last_update_at, created_at) desc`, true);
      return json({ people, items });
    }
    if (action === "share") {
      const shared = !!body.shared;
      const title = body.title == null ? null : String(body.title).trim().slice(0, 2000);
      const [it] = await sql`
        update equipe.items set
          shared_at = case when ${shared} and not shared then now() else shared_at end,
          report_unread = case when ${shared} and not shared then true else report_unread end,
          title_local = case when ${title}::text is not null and ${title}::text <> coalesce(title, vault_text) then null else title_local end,
          title = coalesce(nullif(${title}::text, ''), title, vault_text),
          shared = ${shared},
          updated_at = now()
        where id = ${String(body.item_id)}::uuid returning id, shared`;
      if (!it) return json({ error: "not_found" }, 404);
      return json({ ok: true, item: it });
    }
    if (action === "reply") {
      const text = String(body.body ?? "").trim();
      const status = body.status ? String(body.status) : null;
      if (!text || text.length > 8000) return json({ error: "bad_body" }, 400);
      if (status && !ADMIN_STATUSES.includes(status)) return json({ error: "bad_status" }, 400);
      const [it] = await sql`select id from equipe.items where id = ${String(body.item_id)}::uuid`;
      if (!it) return json({ error: "not_found" }, 404);
      await sql`insert into equipe.updates (item_id, author, body, status) values (${it.id}, 'jf', ${text}, ${status})`;
      await sql`update equipe.items set last_update_at = now(), report_unread = true, jf_unread = false, updated_at = now(),
                status = coalesce(${status}, status) where id = ${it.id}`;
      return json({ ok: true });
    }
    if (action === "set_status") {
      const status = String(body.status ?? "");
      if (!ADMIN_STATUSES.includes(status)) return json({ error: "bad_status" }, 400);
      const [it] = await sql`update equipe.items set status = ${status}, updated_at = now(), report_unread = true, jf_unread = false
                             where id = ${String(body.item_id)}::uuid returning id`;
      if (!it) return json({ error: "not_found" }, 404);
      await sql`insert into equipe.updates (item_id, author, body, status) values (${it.id}, 'system', ${"status:" + status}, ${status})`;
      return json({ ok: true });
    }
    if (action === "import") {
      // Upsert open to-dos from the vault: [{slug, text, link}]. Used by Claude's sync.
      const rows = Array.isArray(body.items) ? body.items.slice(0, 2000) : [];
      let added = 0;
      for (const r of rows) {
        const res = await sql`
          insert into equipe.items (person_slug, vault_key, vault_text, source_link)
          values (${String(r.slug)}, md5(${String(r.slug)} || '|' || ${String(r.text)}), ${String(r.text)}, ${r.link ?? null})
          on conflict (vault_key) do nothing returning id`;
        added += res.length;
      }
      return json({ ok: true, added });
    }
    if (action === "link") {
      const [p] = await sql`select token from equipe.people where slug = ${String(body.slug ?? "")} and not is_admin`;
      if (!p) return json({ error: "not_found" }, 404);
      return json({ token: p.token });
    }
    if (action === "mark_read") {
      await sql`update equipe.items set jf_unread = false where id = ${String(body.item_id)}::uuid`;
      return json({ ok: true });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
