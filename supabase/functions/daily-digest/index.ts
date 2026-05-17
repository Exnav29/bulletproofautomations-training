import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
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
  return Object.entries(items)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `<tr><td>${escapeHtml(label)}</td><td align="right"><strong>${count}</strong></td></tr>`)
    .join('')
}

serve(async () => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const { data, error } = await supabase
      .from('waitlist_signups')
      .select('*')
      .eq('workshop_slug', 'price-by-value')
      .order('signup_date_time', { ascending: false })

    if (error) throw error

    const allSignups = data || []
    const now = new Date()
    const todayStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()).toISOString()
    const tomorrowStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1).toISOString()
    const todaySignups = allSignups.filter((s) => s.signup_date_time >= todayStart && s.signup_date_time < tomorrowStart)
    const todayVip = todaySignups.filter((s) => s.vip_pricing_review_interest === 'Yes')
    const totalVip = allSignups.filter((s) => s.vip_pricing_review_interest === 'Yes').length
    const paidSeats = allSignups.filter((s) => s.payment_status === 'Paid').length
    const seatsRemaining = Math.max(0, TARGET_SEATS - paidSeats)

    const todayRows = todaySignups.map((s) => `
      <tr>
        <td>${escapeHtml(s.full_name)}</td>
        <td>${escapeHtml(s.email)}</td>
        <td>${escapeHtml(s.whatsapp_number)}</td>
        <td>${escapeHtml(s.city)}</td>
        <td>${escapeHtml(s.source || 'direct')}</td>
        <td>${escapeHtml(s.price_range_interest)}</td>
        <td>${escapeHtml(s.biggest_pricing_challenge || '-')}</td>
      </tr>
    `).join('')

    const html = `
      <style>
        body { font-family: Inter, Arial, sans-serif; color: #222; }
        table { width: 100%; border-collapse: collapse; margin: 12px 0 24px; }
        td, th { border-bottom: 1px solid #eee; padding: 8px; text-align: left; vertical-align: top; }
        .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .stat { background: #f7f7f7; border-radius: 10px; padding: 14px; }
        .stat strong { display: block; font-size: 24px; color: #b8941f; }
      </style>
      <h2>Daily waitlist digest: Price by Value</h2>
      <div class="stats">
        <div class="stat"><strong>${todaySignups.length}</strong>New signups today</div>
        <div class="stat"><strong>${allSignups.length}</strong>Total signups</div>
        <div class="stat"><strong>${todayVip.length}</strong>VIP-interest today</div>
        <div class="stat"><strong>${totalVip}</strong>Total VIP-interest</div>
        <div class="stat"><strong>${paidSeats}</strong>Paid confirmed seats</div>
        <div class="stat"><strong>${seatsRemaining}</strong>Seats remaining</div>
      </div>
      <h3>Signup source breakdown</h3>
      <table>${rowsForBreakdown(countBy(allSignups, 'source'))}</table>
      <h3>Price-range interest breakdown</h3>
      <table>${rowsForBreakdown(countBy(allSignups, 'price_range_interest'))}</table>
      <h3>Today's signups and pricing challenges</h3>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>WhatsApp</th><th>City</th><th>Source</th><th>Price range</th><th>Challenge</th></tr></thead>
        <tbody>${todayRows || '<tr><td colspan="7">No signups today.</td></tr>'}</tbody>
      </table>
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
          subject: `Daily waitlist digest: ${todaySignups.length} new signup(s)`,
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
        newSignupsToday: todaySignups.length,
        totalSignups: allSignups.length,
        vipToday: todayVip.length,
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
