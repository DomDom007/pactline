// Pactline: keeps a contract for each upstream table and warns when a new sample changes its shape, before dashboards break.
import { useState } from "react";
import { uid, useCopy, useStored } from "./lib/store";
import { Section, Stat, Stats } from "./ui/kit";

const T = "pactline";
type Schema = Record<string, string>;
type Contract = { id: string; table: string; owner: string; consumers: string; schema: Schema; checked?: string };
type Change = { kind: "removed" | "type" | "renamed" | "added"; col: string; detail: string; breaking: boolean };

/** Read a schema from SQL CREATE TABLE, a JSON schema, a JSON sample row or array, or a CSV header plus a row. */
function readSchema(text: string): Schema {
  const t = text.trim(); if (!t) return {};
  const create = t.match(/create\s+table[^(]*\(([\s\S]+)\)/i);
  if (create) return Object.fromEntries(create[1].split(/,(?![^(]*\))/).map(l => l.trim().match(/^["`[]?(\w+)["`\]]?\s+([\w]+(?:\([^)]*\))?)/)).filter(m => m && !/^(primary|foreign|constraint|unique|key|index)$/i.test(m[1])).map(m => [m![1].toLowerCase(), m![2].toLowerCase().replace(/\(.*\)/, "")]));
  if (t.startsWith("{") || t.startsWith("[")) {
    const j = JSON.parse(t);
    if (j.properties) return Object.fromEntries(Object.entries(j.properties as Record<string, { type?: string | string[]; format?: string }>).map(([k, v]) => [k.toLowerCase(), [v.type].flat()[0] + (v.format ? `:${v.format}` : "")]));
    const row = Array.isArray(j) ? j[0] : j;
    return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k.toLowerCase(), v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? "timestamp" : typeof v]));
  }
  const [head, row = ""] = t.split("\n"), cells = row.split(",");
  return Object.fromEntries(head.split(",").map((h, i) => { const v = (cells[i] ?? "").trim(); return [h.trim().toLowerCase(), /^-?\d+$/.test(v) ? "integer" : /^-?\d+\.\d+$/.test(v) ? "number" : /^\d{4}-\d{2}-\d{2}/.test(v) ? "timestamp" : /^(true|false)$/i.test(v) ? "boolean" : "string"]; }));
}
const family = (t: string) => /int|serial|bigint|smallint/.test(t) ? "integer" : /num|dec|float|double|real|money/.test(t) ? "number" : /time|date/.test(t) ? "timestamp" : /bool/.test(t) ? "boolean" : /json|array|object/.test(t) ? "object" : "string";
const similar = (a: string, b: string) => { const x = a.replace(/_/g, ""), y = b.replace(/_/g, ""); return x.includes(y) || y.includes(x) || [...x].filter((c, i) => y[i] === c).length / Math.max(x.length, y.length) > 0.6; };

function diff(old: Schema, now: Schema): Change[] {
  const out: Change[] = [];
  const removed = Object.keys(old).filter(k => !(k in now)), added = Object.keys(now).filter(k => !(k in old));
  removed.forEach(k => {
    const ren = added.find(a => family(now[a]) === family(old[k]) && similar(a, k));
    if (ren) { out.push({ kind: "renamed", col: k, detail: `looks renamed to ${ren}`, breaking: true }); added.splice(added.indexOf(ren), 1); }
    else out.push({ kind: "removed", col: k, detail: "column is gone", breaking: true });
  });
  Object.keys(old).filter(k => k in now && family(old[k]) !== family(now[k])).forEach(k => out.push({ kind: "type", col: k, detail: `${old[k]} became ${now[k]}`, breaking: !(family(old[k]) === "integer" && family(now[k]) === "number") }));
  added.forEach(k => out.push({ kind: "added", col: k, detail: now[k], breaking: false }));
  return out;
}

export default function Pactline() {
  const [contracts, setContracts] = useStored<Contract[]>(T, "contracts", [
    { id: "c1", table: "analytics.orders", owner: "@data-platform", consumers: "Revenue dashboard, Finance weekly export", schema: readSchema("CREATE TABLE orders (order_id bigint primary key, customer_id bigint, amount numeric(10,2), currency varchar(3), status varchar(20), created_at timestamp)") },
    { id: "c2", table: "events.signups", owner: "@growth-eng", consumers: "Funnel report", schema: readSchema('{"user_id": 123, "plan": "pro", "source": "ads", "signed_up_at": "2026-09-01T10:00:00Z"}') },
  ]);
  const [openId, setOpenId] = useState("c1");
  const [sample, setSample] = useState("CREATE TABLE orders (id bigint primary key, customer_id bigint, amount varchar(20), currency varchar(3), created_at timestamp, channel varchar(20))");
  const [nc, setNc] = useState({ table: "", owner: "", consumers: "", text: "" });
  const { copy, copied } = useCopy();
  const c = contracts.find(x => x.id === openId) ?? contracts[0];
  let changes: Change[] = [], err = "";
  try { changes = c && sample.trim() ? diff(c.schema, readSchema(sample)) : []; } catch { err = "Could not read that sample. Paste SQL, JSON or a CSV header with one row."; }
  const breaking = changes.filter(x => x.breaking);
  const alert = c ? `Schema change on ${c.table} (${breaking.length} breaking)\n${changes.map(x => `${x.breaking ? "BREAKING" : "added"}: ${x.col} ${x.detail}`).join("\n")}\nOwner: ${c.owner}. Affects: ${c.consumers}` : "";

  return (
    <div className="stack">
      <Section title="Data contracts">
        <Stats><Stat value={contracts.length} label="Tables under contract" /><Stat value={breaking.length} label="Breaking changes in this sample" tone={breaking.length ? "bad" : "good"} /><Stat value={changes.filter(x => !x.breaking).length} label="Safe additions" /></Stats>
      </Section>
      <div className="grid2">
        <Section title="Check a new sample">
          <label className="field" style={{ marginBottom: 10 }}><span>Contract</span><select id="pl-c" className="input" value={c?.id} onChange={e => setOpenId(e.target.value)}>{contracts.map(x => <option key={x.id} value={x.id}>{x.table}</option>)}</select></label>
          <label className="field"><span>Paste today's schema: SQL, a JSON row or schema, or a CSV header with one row</span><textarea id="pl-s" className="input" rows={6} value={sample} onChange={e => setSample(e.target.value)} style={{ fontFamily: "var(--mono)", fontSize: 12 }} /></label>
          {err && <p className="pill bad" style={{ marginTop: 8 }}>{err}</p>}
        </Section>
        <Section title="Result" aside={changes.length > 0 && <button className="btn small primary" onClick={() => copy(alert)}>{copied ? "Copied" : "Copy alert for the team chat"}</button>}>
          {!changes.length ? <p className="empty-note">{sample.trim() ? "No changes. The table matches its contract." : "Paste a sample to compare."}</p> : (
            <div className="stack" style={{ gap: 6 }}>{changes.map((x, i) => <div key={i} className="row" style={{ alignItems: "center" }}><span className={"pill " + (x.breaking ? "bad" : "good")}>{x.breaking ? "Breaking" : "Safe"}</span><code style={{ fontFamily: "var(--mono)" }}>{x.col}</code><span className="note">{x.detail}</span></div>)}
              {breaking.length > 0 && <p className="note" style={{ marginTop: 8 }}>Affects {c.consumers}. Ask {c.owner} to add a compatibility view or bump the contract version.</p>}
              <button className="btn small" style={{ alignSelf: "flex-start", marginTop: 8 }} onClick={() => { setContracts(contracts.map(x => x.id === c.id ? { ...x, schema: readSchema(sample), checked: new Date().toISOString().slice(0, 10) } : x)); }}>Accept as the new contract</button>
            </div>)}
        </Section>
      </div>
      {c && <Section title={`Contract for ${c.table}`}>
        <div className="row" style={{ marginBottom: 10 }}><label className="field"><span>Owner</span><input className="input" value={c.owner} onChange={e => setContracts(contracts.map(x => x.id === c.id ? { ...x, owner: e.target.value } : x))} /></label><label className="field" style={{ flexGrow: 2 }}><span>Used by</span><input className="input" value={c.consumers} onChange={e => setContracts(contracts.map(x => x.id === c.id ? { ...x, consumers: e.target.value } : x))} /></label></div>
        <div className="pl-cols">{Object.entries(c.schema).map(([k, v]) => <span key={k}><code>{k}</code><em>{v}</em></span>)}</div>
      </Section>}
      <Section title="Add a contract">
        <div className="stack" style={{ gap: 8 }}>
          <div className="row"><input className="input" style={{ flex: 1 }} aria-label="Table" placeholder="schema.table" value={nc.table} onChange={e => setNc({ ...nc, table: e.target.value })} /><input className="input" style={{ flex: 1 }} aria-label="Owner" placeholder="Owner" value={nc.owner} onChange={e => setNc({ ...nc, owner: e.target.value })} /><input className="input" style={{ flex: 2 }} aria-label="Consumers" placeholder="Dashboards and jobs that read it" value={nc.consumers} onChange={e => setNc({ ...nc, consumers: e.target.value })} /></div>
          <textarea className="input" rows={3} aria-label="Schema" placeholder="CREATE TABLE ... or a JSON row" value={nc.text} onChange={e => setNc({ ...nc, text: e.target.value })} style={{ fontFamily: "var(--mono)", fontSize: 12 }} />
          <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => { try { const s = readSchema(nc.text); if (!nc.table.trim() || !Object.keys(s).length) return; const n = { id: uid(), table: nc.table.trim(), owner: nc.owner, consumers: nc.consumers, schema: s }; setContracts([...contracts, n]); setOpenId(n.id); setNc({ table: "", owner: "", consumers: "", text: "" }); } catch { /* ignore bad input */ } }}>Save contract</button>
        </div>
      </Section>
      <style>{`.pl-cols{display:flex;flex-wrap:wrap;gap:8px}.pl-cols span{display:flex;gap:6px;align-items:baseline;border:1px solid var(--line);border-radius:6px;padding:4px 10px}.pl-cols code{font-family:var(--mono);font-size:13px}.pl-cols em{font-style:normal;font-size:12px;color:var(--muted)}`}</style>
    </div>
  );
}
