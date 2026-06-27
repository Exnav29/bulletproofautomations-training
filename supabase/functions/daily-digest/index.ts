import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const SUPABASE_URL = Deno.env.get('PROJECT_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY')
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const OWNER_EMAIL = Deno.env.get('OWNER_EMAIL')
const FROM_EMAIL = Deno.env.get('FROM_EMAIL')
const TARGET_SEATS = 20

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] || char))
}

function countBy(rows: Record<string, unknown>[], key: string) {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const value = String(row[key] || 'Unknown')
    acc[value] = (acc[value] || 0) + 1
    return acc
  }, {})
}

function rowsForBreakdown(items: Record<string, number>) {
  const rows = Object.entries(items)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `<tr><td>${escapeHtml(label)}</td><td align="right"><strong>${count}</strong></td></tr>`)
    .join('')
  return rows || '<tr><td colspan="2">No data yet.</td></tr>'
}

function signupRows(rows: Record<string, unknown>[]) {
  return rows.map((s) => `
    <tr>
      <td>${escapeHtml(s.signup_date_time)}</td>
      <td>${escapeHtml(s.full_name)}</td>
      <td>${escapeHtml(s.email)}</td>
      <td>${escapeHtml(s.whatsapp_number)}</td>
      <td>${escapeHtml(s.city)}</td>
      <td>${escapeHtml(s.workshop_slug)}</td>
      <td>${escapeHtml(s.interested_class || '-')}</td>
      <td>${escapeHtml(s.preferred_setup || '-')}</td>
      <td>${escapeHtml(s.experience_level || '-')}</td>
      <td>${escapeHtml(s.source || 'direct')}</td>
      <td>${escapeHtml(s.status || 'New')}</td>
    </tr>
  `).join('')
}

function groupedSignupSections(rows: Record<string, unknown>[]) {
  if (!rows.length) return '<p>No new signups in the last 24 hours.</p>'

  const grouped = rows.reduce<Record<string, Record<string, unknown>[]>>((acc, row) => {
    const slug = String(row.workshop_slug || 'unknown')
    if (!acc[slug]) acc[slug] = []
    acc[slug].push(row)
    return acc
  }, {})

  return Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, signups]) => `
      <h3>${escapeHtml(slug)} (${signups.length})</h3>
      <table>
        <thead>
          <tr>
            <th>Signup time</th><th>Name</th><th>Email</th><th>WhatsApp</th><th>City/Country</th>
            <th>Workshop</th><th>Interested class</th><th>Preferred setup</th><th>Experience</th><th>Source</th><th>Status</th>
          </tr>
        </thead>
        <tbody>${signupRows(signups)}</tbody>
      </table>
    `).join('')
}

serve(async () => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('PROJECT_URL and SERVICE_ROLE_KEY are required')
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const { data, error } = await supabase
      .from('waitlist_signups')
      .select('*')
      .order('signup_date_time', { ascending: false })

    if (error) throw error

    const allSignups = data || []
    const now = new Date()
    const windowEnd = now.toISOString()
    const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const recentSignups = allSignups.filter((s) => s.signup_date_time >= windowStart && s.signup_date_time < windowEnd)
    const priceByValueSignups = allSignups.filter((s) => s.workshop_slug === 'price-by-value')
    const n8nSignups = allSignups.filter((s) => s.workshop_slug === 'n8n-foundations')
    const recentVip = recentSignups.filter((s) => s.vip_pricing_review_interest === 'Yes')
    const totalVip = allSignups.filter((s) => s.vip_pricing_review_interest === 'Yes').length
    const paidSeats = priceByValueSignups.filter((s) => s.payment_status === 'Paid').length
    const seatsRemaining = Math.max(0, TARGET_SEATS - paidSeats)

    const html = `
      <style>
        body { font-family: Inter, Arial, sans-serif; color: #222; }
        table { width: 100%; border-collapse: collapse; margin: 12px 0 24px; }
        td, th { border-bottom: 1px solid #eee; padding: 8px; text-align: left; vertical-align: top; }
        .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .stat { background: #f7f7f7; border-radius: 10px; padding: 14px; }
        .stat strong { display: block; font-size: 24px; color: #b8941f; }
      </style>
      <h2>Daily training interest digest</h2>
      <p>Scheduled for 10:00 AM GMT / UTC. Detailed signup listing covers the previous 24 hours: ${escapeHtml(windowStart)} through ${escapeHtml(windowEnd)}.</p>
      <div class="stats">
        <div class="stat"><strong>${recentSignups.length}</strong>New signups in the last 24 hours</div>
        <div class="stat"><strong>${allSignups.length}</strong>Total signups</div>
        <div class="stat"><strong>${priceByValueSignups.length}</strong>Price by Value total</div>
        <div class="stat"><strong>${n8nSignups.length}</strong>n8n Foundations total</div>
        <div class="stat"><strong>${recentVip.length}</strong>VIP-interest in the last 24 hours</div>
        <div class="stat"><strong>${totalVip}</strong>Total VIP-interest</div>
        <div class="stat"><strong>${paidSeats}</strong>Price by Value paid seats</div>
        <div class="stat"><strong>${seatsRemaining}</strong>Price by Value seats remaining</div>
      </div>
      <h3>Signup source breakdown</h3>
      <table>${rowsForBreakdown(countBy(allSignups, 'source'))}</table>
      <h3>Workshop breakdown</h3>
      <table>${rowsForBreakdown(countBy(allSignups, 'workshop_slug'))}</table>
      <h3>Interested class breakdown</h3>
      <table>${rowsForBreakdown(countBy(allSignups, 'interested_class'))}</table>
      <h3>Preferred setup breakdown</h3>
      <table>${rowsForBreakdown(countBy(allSignups, 'preferred_setup'))}</table>
      <h3>Signups from the last 24 hours by workshop/class</h3>
      ${groupedSignupSections(recentSignups)}
      <p><a href="https://training.bulletproofautomations.com/admin">Open admin dashboard</a></p>
    `

    if (RESEND_API_KEY && OWNER_EMAIL && FROM_EMAIL) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: `Bulletproof Automations Training <${FROM_EMAIL}>`,
          to: OWNER_EMAIL,
          subject: `Daily training digest: ${recentSignups.length} new signup(s) in the last 24 hours`,
          html,
        }),
      })
      if (!response.ok) throw new Error(await response.text())
    } else {
      console.warn('Digest email skipped: RESEND_API_KEY, OWNER_EMAIL, or FROM_EMAIL is not configured.')
    }

    return new Response(JSON.stringify({
      success: true,
      stats: {
        newSignupsLast24Hours: recentSignups.length,
        totalSignups: allSignups.length,
        priceByValueTotal: priceByValueSignups.length,
        n8nFoundationsTotal: n8nSignups.length,
        vipLast24Hours: recentVip.length,
        vipTotal: totalVip,
        paidConfirmedSeats: paidSeats,
        seatsRemaining,
      },
    }), { headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    console.error('daily-digest error:', error)
    const message = error instanceof Error ? error.message : String(error)
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
