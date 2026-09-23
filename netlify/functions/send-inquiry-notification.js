// Sends a notification email to a center's contact address whenever a new
// booking inquiry is logged. Called from the client right after an inquiry
// is saved to Supabase — this only sends the notification, it never gates
// or blocks the inquiry itself, since a failed email shouldn't make a
// tutor think their submission didn't go through.
//
// Uses Resend's plain REST API via fetch rather than their SDK, to stay
// dependency-free — same pattern as verify-google-signin.js.

const COMMITMENT_LABELS = {
  "1_month": "1 month (trial)",
  "3_months": "3 months",
  "6_months": "6 months",
  "9_months": "9 months",
  "12_months": "12 months",
  ongoing: "Ongoing — not sure yet",
};

function slotSummary(slots) {
  if (!slots || !slots.length) return null;
  return slots.map((s) => `${s.day} ${s.from}–${s.to}`).join(", ");
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const { toEmail, centerName, roomName, tutorName, tutorContact, slots, date, start, durationHours, startDate, commitmentLength, notes } =
    body || {};

  if (!toEmail) {
    return new Response(JSON.stringify({ error: "Missing toEmail" }), { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Fail quietly from the caller's perspective — the inquiry itself is
    // already saved; this just means the notification couldn't send.
    console.error("RESEND_API_KEY is not set");
    return new Response(JSON.stringify({ error: "Email is not configured" }), { status: 500 });
  }

  const scheduleLine = slotSummary(slots) || (date ? `${date} ${start || ""} · ${durationHours || ""}h` : "");
  const commitmentLine = commitmentLength ? COMMITMENT_LABELS[commitmentLength] || commitmentLength : null;

  const html = `
    <div style="font-family: Arial, sans-serif; color: #1C2B3A; max-width: 520px;">
      <h2 style="font-family: Georgia, serif; margin-bottom: 4px;">New booking inquiry</h2>
      <p style="color: #5B6570; margin-top: 0;">${escapeHtml(centerName)} — ${escapeHtml(roomName)}</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr><td style="padding: 4px 0; color: #5B6570;">From</td><td style="padding: 4px 0;">${escapeHtml(tutorName)}</td></tr>
        <tr><td style="padding: 4px 0; color: #5B6570;">Contact</td><td style="padding: 4px 0;">${escapeHtml(tutorContact)}</td></tr>
        ${scheduleLine ? `<tr><td style="padding: 4px 0; color: #5B6570;">Requested slots</td><td style="padding: 4px 0;">${escapeHtml(scheduleLine)}</td></tr>` : ""}
        ${startDate ? `<tr><td style="padding: 4px 0; color: #5B6570;">Starting</td><td style="padding: 4px 0;">${escapeHtml(startDate)}</td></tr>` : ""}
        ${commitmentLine ? `<tr><td style="padding: 4px 0; color: #5B6570;">Commitment</td><td style="padding: 4px 0;">${escapeHtml(commitmentLine)}</td></tr>` : ""}
        ${notes ? `<tr><td style="padding: 4px 0; color: #5B6570;">Notes</td><td style="padding: 4px 0;">"${escapeHtml(notes)}"</td></tr>` : ""}
      </table>
      <p style="margin-top: 20px;">
        <a href="https://sharedclassrooms.com/?tab=manage" style="background: #2F6D5C; color: #fff; padding: 10px 18px; border-radius: 4px; text-decoration: none; font-weight: 600;">Review in Manage Listing</a>
      </p>
      <p style="color: #5B6570; font-size: 12px; margin-top: 24px;">
        The decision to accept or decline is entirely yours — this is just a notification. Manage it from your Manage Listing screen at any time.
      </p>
    </div>
  `;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "SharedClassrooms <notifications@sharedclassrooms.com>",
        to: [toEmail],
        subject: `New booking inquiry — ${roomName || "your classroom"}`,
        html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Resend send failed", res.status, errText);
      return new Response(JSON.stringify({ error: "Failed to send email" }), { status: 502 });
    }

    return new Response(JSON.stringify({ sent: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("send-inquiry-notification error", e);
    return new Response(JSON.stringify({ error: "Failed to send email" }), { status: 502 });
  }
};
