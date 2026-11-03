/**
 * A small PostgREST stand-in over PGlite, for tests that drive real Pages Functions.
 * Supports what those functions send: table GET with eq/neq/gte/lte/in filters,
 * select, order, limit; POST (insert, on_conflict ignore); PATCH; and rpc/<fn>, where
 * set-returning functions answer arrays and scalar functions answer the value.
 */
import { PGlite } from 'npm:@electric-sql/pglite@0.3.14'

type Row = Record<string, any>

export async function loadDatabase(files: URL[]): Promise<PGlite> {
  const pg = new PGlite()
  for (const f of files) await pg.exec(await Deno.readTextFile(f))
  return pg
}

const ident = (name: string) => {
  if (!/^[a-z_]+$/.test(name)) throw new Error(`stand-in: bad identifier ${name}`)
  return name
}
const param = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)

function where(params: URLSearchParams, first: number): [string, unknown[]] {
  const parts: string[] = [], values: unknown[] = []
  for (const [key, value] of params) {
    if (['select', 'order', 'limit', 'on_conflict'].includes(key)) continue
    const dot = value.indexOf('.')
    const op = value.slice(0, dot), operand = value.slice(dot + 1)
    const col = `${ident(key)}`
    if (op === 'in') {
      const list = operand.replace(/^\(|\)$/g, '').split(',').filter(Boolean)
      parts.push(`${col}::text = any($${first + values.length}::text[])`)
      values.push(list)
    } else {
      const sqlOp = { eq: '=', neq: '<>', gte: '>=', lte: '<=', gt: '>', lt: '<' }[op]
      if (!sqlOp) throw new Error(`stand-in: unsupported operator ${op}`)
      // Compare timestamps as timestamps, everything else as text.
      const cast = ['gte', 'lte', 'gt', 'lt'].includes(op) ? `${col} ${sqlOp} $${first + values.length}::timestamptz`
        : `${col}::text ${sqlOp} $${first + values.length}`
      parts.push(cast)
      values.push(operand)
    }
  }
  return [parts.length ? ` where ${parts.join(' and ')}` : '', values]
}

export interface StandIn {
  url: string
  fail: Set<string> // table or "rpc/<name>" to answer 500
}

export function serveDatabase(pg: PGlite, port: number): StandIn {
  const fail = new Set<string>()
  Deno.serve({ port, onListen() {} }, async (req) => {
    const url = new URL(req.url)
    const path = url.pathname.replace('/rest/v1/', '')
    const params = url.searchParams
    if (fail.has(path)) return new Response('db down', { status: 500 })
    try {
      if (path.startsWith('rpc/')) {
        const name = ident(path.slice(4))
        const args = await req.json()
        const keys = Object.keys(args).map(ident)
        const set = (await pg.query<{ s: boolean }>(
          `select proretset as s from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace limit 1`, [name])).rows[0]
        if (!set) return Response.json({ code: 'PGRST202' }, { status: 404 })
        const call = `public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`
        const rows = (await pg.query<{ j: unknown }>(`select to_jsonb(x) as j from ${call} x`, keys.map((k) => param(args[k])))).rows
        const out = set.s ? rows.map((r) => r.j) : rows[0]?.j ?? null
        // Single-column scalar wrappers come back as {name: value}; unwrap them.
        const unwrap = (v: any) => (v && typeof v === 'object' && !Array.isArray(v) && name in v && Object.keys(v).length === 1 ? v[name] : v)
        return Response.json(set.s ? out : unwrap(out))
      }
      const table = ident(path)
      if (req.method === 'POST') {
        const row = await req.json()
        const cols = Object.keys(row).map(ident)
        const conflict = params.get('on_conflict')
        const sql = `with ins as (insert into public.${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})` +
          (conflict ? ` on conflict (${conflict.split(',').map(ident).join(', ')}) do nothing` : '') +
          ` returning *) select row_to_json(ins) as j from ins`
        const rows = (await pg.query<{ j: Row }>(sql, cols.map((c) => param(row[c])))).rows.map((r) => r.j)
        return Response.json(rows, { status: 201 })
      }
      if (req.method === 'PATCH') {
        const patch = await req.json()
        const cols = Object.keys(patch).map(ident)
        const [w, wv] = where(params, cols.length + 1)
        await pg.query(`update public.${table} set ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}${w}`,
          [...cols.map((c) => param(patch[c])), ...wv])
        return new Response(null, { status: 204 })
      }
      const cols = (params.get('select') ?? '*').split(',').map((c) => (c === '*' ? c : ident(c))).join(', ')
      const [w, wv] = where(params, 1)
      const order = params.get('order')
      const by = order ? ` order by ${ident(order.split('.')[0])} ${order.endsWith('.desc') ? 'desc' : 'asc'}` : ''
      const limit = params.get('limit') ? ` limit ${Number(params.get('limit'))}` : ''
      const rows = (await pg.query<{ j: Row }>(`select row_to_json(x) as j from (select ${cols} from public.${table}${w}${by}${limit}) x`, wv)).rows
      return Response.json(rows.map((r) => r.j))
    } catch (err) {
      return Response.json({ message: String((err as Error).message) }, { status: 400 })
    }
  })
  return { url: `http://127.0.0.1:${port}`, fail }
}
