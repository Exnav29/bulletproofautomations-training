import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
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
    if (!record?.email) {
      return new Response(JSON.stringify({ error: 'Missing signup record' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!RESEND_API_KEY || !FROM_EMAIL) {
      console.warn('Resend confirmation skipped: RESEND_API_KEY or FROM_EMAIL is not configured.')
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const firstName = escapeHtml(String(record.full_name || 'there').split(' ')[0])
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 20px;color:#222;">
        <h2 style="margin:0 0 16px;color:#0a0a0f;">You're on the Price by Value waitlist</h2>
        <p>Hi ${firstName},</p>
        <p>You're on the waitlist for <strong>Price by Value: How to Stop Undercharging for AI Automations</strong>.</p>
        <p>This Ghana-focused in-person workshop teaches builders how to price AI automations and n8n workflows based on business value instead of hours worked.</p>
        <p><strong>First cohort seats will be limited.</strong> Watch your email or WhatsApp for early access details.</p>
        <p style="margin-top:28px;color:#666;font-size:14px;">Bulletproof Automations Training<br><a href="https://training.bulletproofautomations.com">training.bulletproofautomations.com</a></p>
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
        to: record.email,
        subject: "You're on the Price by Value waitlist",
        html,
      }),
    })

    if (!response.ok) throw new Error(await response.text())

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('confirm-email error:', error)
    const message = error instanceof Error ? error.message : String(error)
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
