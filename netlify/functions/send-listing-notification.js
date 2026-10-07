// Sends a notification email to the SharedClassrooms admin whenever a center
// submits new classroom listings — either a brand-new center through
// "List Your Space", or an existing center adding a classroom from
// Manage Listing. One email per submission, not one per classroom.
//
// Best-effort only: the listing is already saved before this is called, so
// a failed email never blocks or undoes a submission.
//
// The recipient comes from the ADMIN_NOTIFY_EMAIL environment variable
// (server-side only — deliberately NOT a VITE_ variable, so the address is
// never bundled into the public frontend code). Comma-separate several
// addresses to notify more than one person.

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

  const { isNewCenter, centerName, contactName, phone, contactEmail, address, postalCode, roomNames, addressMatchWarning } =
    body || {};

  const apiKey = process.env.RESEND_API_KEY;
  const adminEmails = (process.env.ADMIN_NOTIFY_EMAIL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!apiKey || !adminEmails.length) {
    console.error("RESEND_API_KEY or ADMIN_NOTIFY_EMAIL is not set");
    return new Response(JSON.stringify({ error: "Email is not configured" }), { status: 500 });
  }

  const rooms = Array.isArray(roomNames) ? roomNames : [];
  const roomCount = rooms.length || 1;
  const headline = isNewCenter ? "New center listed" : "New classroom added";
  const row = (label, value) =>
    value
      ? `<tr><td style="padding: 4px 12px 4px 0; color: #5B6570; vertical-align: top;">${label}</td><td style="padding: 4px 0;">${escapeHtml(value)}</td></tr>`
      : "";

  const html = `
    <div style="font-family: Arial, sans-serif; color: #1C2B3A; max-width: 520px;">
      <h2 style="font-family: Georgia, serif; margin-bottom: 4px;">${headline}</h2>
      <p style="color: #5B6570; margin-top: 0;">${escapeHtml(centerName)} · ${roomCount} classroom${roomCount === 1 ? "" : "s"} awaiting audit</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        ${row("Classrooms", rooms.join(", "))}
        ${row("Contact", contactName)}
        ${row("Phone", phone)}
        ${row("Email", contactEmail)}
        ${row("Address", [address, postalCode].filter(Boolean).join(" "))}
      </table>
      ${
        addressMatchWarning
          ? `<p style="background: #FFF4E5; border-left: 3px solid #C77700; padding: 8px 12px; font-size: 13px;">${escapeHtml(addressMatchWarning)}</p>`
          : ""
      }
      <p style="margin-top: 20px;">
        <a href="https://sharedclassrooms.com/?tab=admin" style="background: #2F6D5C; color: #fff; padding: 10px 18px; border-radius: 4px; text-decoration: none; font-weight: 600;">Open Admin audit queue</a>
      </p>
      <p style="color: #5B6570; font-size: 12px; margin-top: 24px;">
        These listings stay hidden from tutors until you've visited and marked them verified.
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
        to: adminEmails,
        subject: `${headline} — ${centerName || "a center"} (${roomCount} classroom${roomCount === 1 ? "" : "s"})`,
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
    console.error("send-listing-notification error", e);
    return new Response(JSON.stringify({ error: "Failed to send email" }), { status: 502 });
  }
};
