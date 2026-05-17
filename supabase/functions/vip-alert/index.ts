import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const OWNER_EMAIL = Deno.env.get('OWNER_EMAIL')
const FROM_EMAIL = Deno.env.get('FROM_EMAIL')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] || char))
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { record } = await req.json()
    if (record?.vip_pricing_review_interest !== 'Yes') {
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!RESEND_API_KEY || !OWNER_EMAIL || !FROM_EMAIL) {
      console.warn('VIP alert skipped: RESEND_API_KEY, OWNER_EMAIL, or FROM_EMAIL is not configured.')
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:650px;margin:0 auto;padding:32px 20px;color:#222;">
        <h2>VIP pricing review interest</h2>
        <p><strong>Name:</strong> ${escapeHtml(record.full_name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(record.email)}</p>
        <p><strong>WhatsApp:</strong> ${escapeHtml(record.whatsapp_number)}</p>
        <p><strong>City:</strong> ${escapeHtml(record.city)}</p>
        <p><strong>Experience:</strong> ${escapeHtml(record.experience_level)}</p>
        <p><strong>Build type:</strong> ${escapeHtml(record.current_build_type)}</p>
        <p><strong>Price range:</strong> ${escapeHtml(record.price_range_interest)}</p>
        <p><strong>Source:</strong> ${escapeHtml(record.source || 'direct')}</p>
        <p><strong>Challenge:</strong><br>${escapeHtml(record.biggest_pricing_challenge || 'Not provided')}</p>
        <p style="margin-top:28px;"><a href="https://training.bulletproofautomations.com/admin">Open admin dashboard</a></p>
      </div>
    `

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `Bulletproof Automations Training <${FROM_EMAIL}>`,
        to: OWNER_EMAIL,
        subject: `VIP interest signup: ${record.full_name || record.email}`,
        html,
      }),
    })

    if (!response.ok) throw new Error(await response.text())

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('vip-alert error:', error)
    const message = error instanceof Error ? error.message : String(error)
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
