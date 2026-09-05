// Verifies a Google Sign-In ID token server-side before trusting the email
// inside it. This is the piece the client-side mock explicitly couldn't do —
// without this check, anyone could hand the browser a fabricated token
// claiming to be any email address.
//
// Uses Google's own tokeninfo endpoint rather than a JWT library: Google
// provides this specifically for verification (it checks the signature,
// issuer, and expiry for you), which keeps this function dependency-free.
// Fine at this app's expected login volume; if usage ever grows large
// enough to hit the endpoint's rate limit, switching to Google's
// server-side auth library (local signature verification, no network call
// per login) is the natural next step.

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

  const idToken = body?.id_token;
  if (!idToken) {
    return new Response(JSON.stringify({ error: "Missing id_token" }), { status: 400 });
  }

  const expectedClientId = process.env.VITE_GOOGLE_CLIENT_ID;
  if (!expectedClientId) {
    return new Response(JSON.stringify({ error: "Server is missing VITE_GOOGLE_CLIENT_ID" }), { status: 500 });
  }

  let claims;
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) {
      return new Response(JSON.stringify({ error: "Token could not be verified by Google" }), { status: 401 });
    }
    claims = await res.json();
  } catch {
    return new Response(JSON.stringify({ error: "Verification request to Google failed" }), { status: 502 });
  }

  // aud must match our own client ID — otherwise this token was minted for
  // a completely different application and shouldn't be trusted here.
  if (claims.aud !== expectedClientId) {
    return new Response(JSON.stringify({ error: "Token was not issued for this app" }), { status: 401 });
  }

  if (!claims.email || claims.email_verified !== "true") {
    return new Response(JSON.stringify({ error: "Google account email is not verified" }), { status: 401 });
  }

  return new Response(JSON.stringify({ email: claims.email }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
