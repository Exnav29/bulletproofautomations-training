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

function confirmationFor(record: Record<string, unknown>, firstName: string) {
  if (record.workshop_slug === 'n8n-foundations') {
    return {
      subject: "You're on the n8n Foundations interest list",
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 20px;color:#222;">
          <h2 style="margin:0 0 16px;color:#0a0a0f;">You're on the n8n Foundations interest list</h2>
          <p>Hi ${firstName},</p>
          <p>You're on the interest list for <strong>Beginner Cohort: n8n Foundations</strong>.</p>
          <p>Registration is not open yet, and joining the interest list does not reserve a seat. We will notify you when registration opens.</p>
          <p>The cohort is free, online, hands-on, and runs for 8 weeks. It is portfolio-first: every session produces a portfolio artifact such as exported workflow JSON, screenshots, notes, or a README.</p>
          <p>Participants should prepare for local n8n setup with Docker. If local setup does not work, the n8n Cloud trial can be used as a fallback.</p>
          <p><strong>Meeting links will only be sent to confirmed registrants later, not interest-list members.</strong></p>
          <p style="margin-top:28px;color:#666;font-size:14px;">Bulletproof Automations Training<br><a href="https://training.bulletproofautomations.com">training.bulletproofautomations.com</a></p>
        </div>
      `,
    }
  }

  return {
    subject: "You're on the Price by Value waitlist",
    html: `
      <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 20px;color:#222;">
        <h2 style="margin:0 0 16px;color:#0a0a0f;">You're on the Price by Value waitlist</h2>
        <p>Hi ${firstName},</p>
        <p>You're on the waitlist for <strong>Price by Value: How to Stop Undercharging for AI Automations</strong>.</p>
        <p>This Ghana-focused in-person workshop teaches builders how to price AI automations and n8n workflows based on business value instead of hours worked.</p>
        <p><strong>First cohort seats will be limited.</strong> Watch your email or WhatsApp for early access details.</p>
        <p style="margin-top:28px;color:#666;font-size:14px;">Bulletproof Automations Training<br><a href="https://training.bulletproofautomations.com">training.bulletproofautomations.com</a></p>
      </div>
    `,
  }
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
    const confirmation = confirmationFor(record, firstName)

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `Bulletproof Automations Training <${FROM_EMAIL}>`,
        to: record.email,
        subject: confirmation.subject,
        html: confirmation.html,
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
