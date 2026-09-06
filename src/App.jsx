import React, { useState, useEffect, useCallback } from "react";
import {
  fetchCenters,
  fetchListings,
  fetchInquiries,
  insertCenter,
  insertListing,
  insertInquiry,
  patchCenter,
  patchListing,
  patchInquiry,
  uploadClassroomPhoto,
  deleteClassroomPhoto,
} from "./lib/db";

/**
 * SharedClassrooms — unified marketplace app (v2)
 * -------------------------------------------------------------
 * Builds on the merged RoomShare + CotClassroomListingForm app with a
 * round of changes from live testing of the intake form:
 *
 *  1. "Room name" removed — classrooms are auto-labelled Classroom A/B/C…
 *     continuing the sequence for a center that already has listings.
 *  2. Availability is now a real per-day grid (each day independently
 *     toggled with its own time range), not one shared time range.
 *  3. The Google Calendar booking link is no longer a self-serve field —
 *     it's captured by Admin during the in-person audit, alongside the
 *     site tour video URL.
 *  4. "Private / en-suite" removed from Toilet access (not a realistic
 *     option for this market); scoring rescaled so the remaining top
 *     option ("Common, within center") reaches the full toilet score.
 *  5. The standalone "High-volume printer?" question is gone — it's now
 *     one checkbox ("High-Volume Printer") living under Service & extras,
 *     and "Printing" was removed from Teaching tools to avoid the overlap.
 *  6. Adding another classroom to the SAME center auto-continues the
 *     letter sequence. A brand-new center whose address matches a
 *     DIFFERENT existing center is flagged to Admin as a possible
 *     shared-premises/duplicate note — never auto-merged.
 *  7. A new "Manage listing" tab lets a center look itself up (phone +
 *     email) and edit later. Self-reported fields (price, schedule,
 *     cleaning frequency, etc.) save immediately. Physically-verified
 *     fields (amenities, toilet type, capacity) push a verified listing
 *     back to "flagged" for a quick re-check, since those are exactly
 *     what "Verified" promises tutors is still true.
 */

// ---------- Design tokens ----------
const COLORS = {
  bg: "#EDEAE1",
  panel: "#FFFFFF",
  panelRaised: "#F7F5EF",
  ink: "#1C2B3A",
  inkSoft: "#5B6570",
  chalk: "#2F6D5C",
  chalkSoft: "#2F6D5C1A",
  brass: "#B8874F",
  brassSoft: "#B8874F1F",
  danger: "#B3432B",
  dangerSoft: "#B3432B1A",
  line: "#D8D3C6",
};

const SERIF = "'Source Serif 4', Georgia, serif";
const SANS = "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif";

const AUDIT_LABEL = {
  pending_review: { text: "Pending audit", bg: COLORS.brassSoft, fg: COLORS.brass },
  verified: { text: "Verified", bg: COLORS.chalkSoft, fg: COLORS.chalk },
  flagged: { text: "Flagged", bg: COLORS.dangerSoft, fg: COLORS.danger },
};

const STANDING_LABEL = {
  active: { text: "Active", bg: COLORS.chalkSoft, fg: COLORS.chalk },
  warned: { text: "Warned", bg: COLORS.brassSoft, fg: COLORS.brass },
  suspended: { text: "Suspended", bg: COLORS.dangerSoft, fg: COLORS.danger },
  banned: { text: "Banned", bg: COLORS.dangerSoft, fg: COLORS.danger },
};

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// A, B, C … Z, AA, AB … — robust past 26 even though that's unlikely here.
function classroomLetter(n) {
  let num = n + 1;
  let s = "";
  while (num > 0) {
    const rem = (num - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s;
}

const AMENITY_GROUPS = [
  {
    label: "Comfort & environment",
    items: ["Air Conditioning", "Free Wi-Fi", "Windows / Natural Lighting"],
  },
  {
    label: "Teaching tools",
    items: ["Whiteboard", "Smart Board / Smart TV", "Projector", "Storage Space for Materials"],
  },
  {
    label: "Service & extras",
    items: [
      "Front Desk Staff",
      "Waiting Area (For Student / Parents)",
      "Complimentary Beverages & Snacks",
      "High-Volume Printer",
    ],
  },
  { label: "Security", items: ["CCTV", "Smart Lock"] },
];

function makeEmptySchedule() {
  const s = {};
  DAYS.forEach((d) => {
    s[d] = { on: false, from: "", to: "" };
  });
  return s;
}

// Sensible starting block for a day just switched on — avoids leaving the
// native time input blank (which browsers default to "now," a strange
// starting point for a weekly recurring schedule).
const DEFAULT_DAY_FROM = "09:00";
const DEFAULT_DAY_TO = "18:00";

function toggledDay(day) {
  const turningOn = !day.on;
  return {
    on: turningOn,
    from: turningOn && !day.from ? DEFAULT_DAY_FROM : day.from,
    to: turningOn && !day.to ? DEFAULT_DAY_TO : day.to,
  };
}

function scheduleSummary(schedule) {
  if (!schedule) return "";
  return DAYS.filter((d) => schedule[d]?.on)
    .map((d) => `${d} ${schedule[d].from || "?"}–${schedule[d].to || "?"}`)
    .join(", ");
}

const emptyClassroom = () => ({
  id: uid(),
  capacity: "",
  schedule: makeEmptySchedule(),
  pricePerHour: "",
  minBookingHours: 2,
  longTermDiscount: false,
  hasDeposit: false,
  deposit: "",
  additionalFees: "",
  amenities: [],
  photos: [],
  expanded: true,
  toiletType: "",
});

const emptyCenterInfo = {
  centerName: "",
  contactName: "",
  phone: "",
  email: "",
  address: "",
  postalCode: "",
  website: "",
  description: "",
  nearestMrt: "",
  mrtWalkMinutes: "",
  transferRequired: "",
  cleaningFrequency: "",
  canPutUpPoster: false,
  jointMarketing: false,
  marketingNotes: "",
};

const LIST_STEPS = ["Center details", "Your classrooms", "Readiness report & submit"];

// -----------------------------------------------------------------------
// READINESS SCORE ENGINE
// -----------------------------------------------------------------------
const PRICE_BAND = { low: 18, high: 40, floor: 10, ceiling: 55 };

const CLEANING_SCORES = { daily: 15, few_weekly: 10, weekly: 6, adhoc: 2 };
const CLEANING_LABELS = {
  daily: "Daily",
  few_weekly: "2–3 times a week",
  weekly: "Weekly",
  adhoc: "Ad-hoc / on request",
};

// "Private / en-suite" removed as an option — not realistic for this market.
// Rescaled so the remaining top option reaches the full toilet score.
const TOILET_SCORES = { common_center: 6, common_building: 2 };

function scoreAccessibility(center) {
  const max = 20;
  const walk = Number(center.mrtWalkMinutes);
  if (!center.mrtWalkMinutes || !center.transferRequired) return { score: 0, max, filled: false };
  let score;
  if (center.transferRequired === "multiple") score = 5;
  else if (center.transferRequired === "bus") score = walk <= 10 ? 12 : 8;
  else {
    if (walk <= 5) score = 20;
    else if (walk <= 10) score = 16;
    else if (walk <= 15) score = 10;
    else score = 6;
  }
  return { score, max, filled: true, walk, transfer: center.transferRequired };
}

function scoreHygiene(center) {
  const max = 15;
  if (!center.cleaningFrequency) return { score: 0, max, filled: false };
  return { score: CLEANING_SCORES[center.cleaningFrequency] ?? 0, max, filled: true, frequency: center.cleaningFrequency };
}

function scoreMarketing(center) {
  const max = 10;
  const score = (center.canPutUpPoster ? 5 : 0) + (center.jointMarketing ? 5 : 0);
  return { score, max, filled: true, canPutUpPoster: center.canPutUpPoster, jointMarketing: center.jointMarketing };
}

function scoreClassroomAmenities(c) {
  const max = 20;
  let score = 0;
  score += TOILET_SCORES[c.toiletType] ?? 0;
  if (c.amenities.includes("Whiteboard")) score += 3;
  if (c.amenities.includes("Smart Board / Smart TV")) score += 5;
  if (c.amenities.includes("High-Volume Printer")) score += 6;
  return { score, max };
}

function scoreClassroomSecurity(c) {
  const max = 15;
  let score = 0;
  if (c.amenities.includes("CCTV")) score += 8;
  if (c.amenities.includes("Smart Lock")) score += 7;
  return { score, max };
}

function scoreClassroomPrice(c) {
  const max = 20;
  const price = Number(c.pricePerHour);
  if (!c.pricePerHour) return { score: 0, max, filled: false };
  const { low, high, floor, ceiling } = PRICE_BAND;
  let score;
  if (price >= low && price <= high) score = 20;
  else if (price >= floor && price < low) score = 14;
  else if (price > high && price <= ceiling) score = 14;
  else score = 6;
  return { score, max, filled: true, price };
}

function average(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function computeReadiness(center, classrooms) {
  const accessibility = scoreAccessibility(center);
  const hygiene = scoreHygiene(center);
  const marketing = scoreMarketing(center);

  const amenitiesPer = classrooms.map(scoreClassroomAmenities);
  const securityPer = classrooms.map(scoreClassroomSecurity);
  const pricePer = classrooms.map(scoreClassroomPrice);

  const amenities = { score: average(amenitiesPer.map((a) => a.score)), max: 20 };
  const security = { score: average(securityPer.map((a) => a.score)), max: 15 };
  const price = {
    score: average(pricePer.map((a) => a.score)),
    max: 20,
    filled: pricePer.some((p) => p.filled),
    per: pricePer,
  };

  const categories = [
    { key: "accessibility", label: "Accessibility", ...accessibility },
    { key: "hygiene", label: "Level of hygiene", ...hygiene },
    { key: "amenities", label: "Amenities", ...amenities },
    { key: "security", label: "Safety & security", ...security },
    { key: "marketing", label: "Marketing support", ...marketing },
    { key: "price", label: "Asking rate vs. market", ...price },
  ];

  const overall = Math.round(categories.reduce((sum, c) => sum + c.score, 0));

  let tier;
  if (overall >= 85) tier = "Marketplace ready";
  else if (overall >= 65) tier = "Nearly there";
  else if (overall >= 45) tier = "Needs some work";
  else tier = "Early stage";

  return { overall, tier, categories, amenitiesPer, securityPer, pricePer };
}

function buildSuggestions(center, classrooms, readiness, labelFor) {
  const tips = [];
  const acc = readiness.categories.find((c) => c.key === "accessibility");
  const hyg = readiness.categories.find((c) => c.key === "hygiene");
  const mkt = readiness.categories.find((c) => c.key === "marketing");

  if (!acc.filled) {
    tips.push("Add your nearest MRT station and walking time — listings with clear transit info are far more likely to get booked.");
  } else if (acc.transfer === "multiple") {
    tips.push("Your center needs multiple transfers to reach — call out any direct bus service or Grab-friendly drop-off point on your listing to offset this.");
  } else if (acc.walk > 10) {
    tips.push(`A ${acc.walk}-minute walk from the MRT is on the longer side — mention any shuttle, sheltered walkway, or nearby bus stop to make the distance feel shorter.`);
  }

  if (!hyg.filled) {
    tips.push("Let us know how often the space is cleaned.");
  } else if (hyg.frequency !== "daily") {
    tips.push(`Cleaning is currently "${CLEANING_LABELS[hyg.frequency]}" — moving to daily cleaning is one of the cheapest ways to raise this score, and it's something tutors and parents notice immediately.`);
  }

  classrooms.forEach((c, i) => {
    const label = classrooms.length > 1 ? `${labelFor(i)}: ` : "";
    if (!c.toiletType) {
      tips.push(`${label}Let us know what kind of toilet access the room has.`);
    } else if (c.toiletType === "common_building") {
      tips.push(`${label}A shared building toilet scores lower than an in-center one — if there's ever a chance to route students to a center-controlled toilet, it's worth it.`);
    }
    if (!c.amenities.includes("Whiteboard")) {
      tips.push(`${label}A basic whiteboard is a cheap, high-impact add (~$50–100) that most tutors expect as standard.`);
    }
    if (!c.amenities.includes("High-Volume Printer")) {
      tips.push(`${label}No high-volume printer on file — even shared access to one nearby is worth noting, since group classes often need handouts.`);
    }
    if (!c.amenities.includes("CCTV")) {
      tips.push(`${label}Installing CCTV is one of the biggest trust signals for tutors bringing groups of students into an unfamiliar space.`);
    }
    if (!c.amenities.includes("Smart Lock")) {
      tips.push(`${label}A digital lock isn't essential, but it's what makes unattended check-in possible later — worth considering if you plan to scale bookings.`);
    }
  });

  if (!mkt.canPutUpPoster) {
    tips.push("Allowing a small SharedClassrooms poster near your entrance costs you nothing and helps tutors and parents discover the space in person.");
  }
  if (!mkt.jointMarketing) {
    tips.push("Being open to occasional joint marketing (e.g. a shared social post when a new tutor starts) tends to fill slots faster.");
  }

  readiness.pricePer.forEach((p, i) => {
    const label = classrooms.length > 1 ? `${labelFor(i)}: ` : "";
    if (!p.filled) return;
    if (p.price < PRICE_BAND.floor) {
      tips.push(`${label}At $${p.price}/hr you're pricing well under the market floor — you may be leaving income on the table even accounting for a lower-frills space.`);
    } else if (p.price > PRICE_BAND.ceiling) {
      tips.push(`${label}At $${p.price}/hr you're above where most tuition-specific listings sit — that can work if the amenities and location justify it, but expect fewer inquiries unless it's clearly a premium space.`);
    } else if (p.price < PRICE_BAND.low || p.price > PRICE_BAND.high) {
      tips.push(`${label}$${p.price}/hr is just outside the $${PRICE_BAND.low}–$${PRICE_BAND.high}/hr band where most tuition classroom listings sit — worth nudging closer unless there's a clear reason for the difference.`);
    }
  });

  return tips;
}

// ---------- Shared UI atoms ----------
function Badge({ label, bg, fg }) {
  return (
    <span style={{ background: bg, color: fg, fontSize: 12, fontWeight: 600, padding: "3px 9px", borderRadius: 999, letterSpacing: 0.2 }}>
      {label}
    </span>
  );
}

function Field({ label, children, hint, error }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.inkSoft, marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 12, color: COLORS.inkSoft, marginTop: 4 }}>{hint}</div>}
      {error && <div style={{ fontSize: 12, color: COLORS.danger, marginTop: 4 }}>{error}</div>}
    </label>
  );
}

const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 11px",
  borderRadius: 3,
  border: `1px solid ${COLORS.line}`,
  fontSize: 14,
  fontFamily: "inherit",
  background: "#fff",
  color: COLORS.ink,
};

function Button({ children, onClick, variant = "primary", type = "button", disabled }) {
  const styles = {
    primary: { background: COLORS.ink, color: "#fff", border: `1px solid ${COLORS.ink}` },
    accent: { background: COLORS.chalk, color: "#fff", border: `1px solid ${COLORS.chalk}` },
    ghost: { background: "transparent", color: COLORS.ink, border: `1px solid ${COLORS.line}` },
    danger: { background: "#fff", color: COLORS.danger, border: `1px solid ${COLORS.danger}` },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles[variant],
        padding: "9px 16px",
        borderRadius: 4,
        fontSize: 14,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: SANS,
      }}
    >
      {children}
    </button>
  );
}

// ---------- Shared: per-day schedule grid ----------
// Used by both the intake form and the "Manage listing" edit screen.
function ScheduleGrid({ schedule, onToggleDay, onTimeChange, error }) {
  return (
    <Field label="Weekly availability" error={error} hint="Toggle on the days you're renting out, and set the hours for each — centers often already run classes on some days, so each day can have its own time range.">
      <div className="sc-form-schedule">
        {DAYS.map((d) => {
          const day = schedule[d] || { on: false, from: "", to: "" };
          return (
            <div className={"sc-form-schedule-row" + (day.on ? " is-on" : "")} key={d}>
              <label className="sc-form-schedule-daylabel">
                <input type="checkbox" checked={day.on} onChange={() => onToggleDay(d)} />
                {d}
              </label>
              <input
                type="time"
                disabled={!day.on}
                value={day.from}
                onChange={(e) => onTimeChange(d, "from", e.target.value)}
              />
              <span className="sc-form-schedule-sep">to</span>
              <input
                type="time"
                disabled={!day.on}
                value={day.to}
                onChange={(e) => onTimeChange(d, "to", e.target.value)}
              />
            </div>
          );
        })}
      </div>
    </Field>
  );
}

// ---------- Shared: amenity checkbox groups ----------
function AmenityPicker({ amenities, onToggle }) {
  return (
    <div className="sc-form-amenity-groups">
      {AMENITY_GROUPS.map((group) => (
        <div className="sc-form-amenity-group" key={group.label}>
          <div className="sc-form-amenity-group-label">{group.label}</div>
          <div className="sc-form-amenity-items">
            {group.items.map((item) => (
              <label className="sc-form-check" key={item}>
                <input type="checkbox" checked={amenities.includes(item)} onChange={() => onToggle(item)} />
                {item}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ================= APP =================
export default function App() {
  const [tab, setTab] = useState("browse");
  const [centers, setCenters] = useState([]);
  const [listings, setListings] = useState([]);
  const [inquiries, setInquiries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPw, setAdminPw] = useState("");

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3200);
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [c, l, i] = await Promise.all([fetchCenters(), fetchListings(), fetchInquiries()]);
      setCenters(c);
      setListings(l);
      setInquiries(i);
    } catch (e) {
      console.error("load error", e);
      showToast("Could not load data — check your connection and try again.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // ---------- derived ----------
  const centerById = (id) => centers.find((c) => c.id === id);
  const listingsWithCenter = listings.map((l) => ({ ...l, center: centerById(l.centerId) }));
  const visibleListings = listingsWithCenter.filter(
    (l) => l.auditStatus === "verified" && l.center && l.center.standing === "active"
  );

  // ---------- actions ----------
  // Each action writes to Supabase first, then folds the confirmed result
  // into local state — if the write fails, local state is left untouched
  // and the person sees a retry prompt instead of a change that silently
  // never actually saved.
  const addCenter = async (center) => {
    try {
      const record = await insertCenter(center);
      setCenters((prev) => [...prev, record]);
      return record.id;
    } catch (e) {
      console.error("addCenter error", e);
      showToast("Could not save — please retry.");
    }
  };

  const addListing = async (listing) => {
    try {
      const record = await insertListing(listing);
      setListings((prev) => [...prev, record]);
    } catch (e) {
      console.error("addListing error", e);
      showToast("Could not save — please retry.");
    }
  };

  const addInquiry = async (inquiry) => {
    try {
      const record = await insertInquiry(inquiry);
      setInquiries((prev) => [...prev, record]);
    } catch (e) {
      console.error("addInquiry error", e);
      showToast("Could not save — please retry.");
    }
  };

  // videoUrl and calendarBookingUrl are both captured by Admin during the
  // in-person audit — the calendar link is onboarded as part of that same
  // visit rather than self-served by the center.
  const setListingAudit = async (id, status, siteTourVideoUrl, calendarBookingUrl) => {
    const patch = {
      auditStatus: status,
      lastAudited: Date.now(),
      ...(siteTourVideoUrl ? { siteTourVideoUrl } : {}),
      ...(calendarBookingUrl ? { calendarBookingUrl } : {}),
    };
    try {
      const merged = await patchListing(id, patch);
      setListings((prev) => prev.map((l) => (l.id === id ? merged : l)));
    } catch (e) {
      console.error("setListingAudit error", e);
      showToast("Could not save — please retry.");
    }
  };

  const setCenterStanding = async (id, standing, note) => {
    const current = centers.find((c) => c.id === id);
    const patch = {
      standing,
      strikes: note ? [...(current?.strikes || []), { note, date: Date.now() }] : current?.strikes,
    };
    try {
      const merged = await patchCenter(id, patch);
      setCenters((prev) => prev.map((c) => (c.id === id ? merged : c)));
    } catch (e) {
      console.error("setCenterStanding error", e);
      showToast("Could not save — please retry.");
    }
  };

  const setInquiryStatus = async (id, status) => {
    try {
      const merged = await patchInquiry(id, { status });
      setInquiries((prev) => prev.map((i) => (i.id === id ? merged : i)));
    } catch (e) {
      console.error("setInquiryStatus error", e);
      showToast("Could not save — please retry.");
    }
  };

  // Self-reported center fields — update freely, no verification consequence.
  const updateCenterInfo = async (id, patch) => {
    try {
      const merged = await patchCenter(id, patch);
      setCenters((prev) => prev.map((c) => (c.id === id ? merged : c)));
    } catch (e) {
      console.error("updateCenterInfo error", e);
      showToast("Could not save — please retry.");
    }
  };

  // Editing a listing. `needsReaudit: true` is for physically-verifiable
  // fields (amenities, toilet type, capacity) — if the listing was live and
  // verified, this pushes it back to "flagged" so it drops out of Browse
  // until a fresh check confirms the change, same as any other re-audit.
  const updateListingInfo = async (id, patch, { needsReaudit = false } = {}) => {
    const current = listings.find((l) => l.id === id);
    const finalPatch = needsReaudit && current?.auditStatus === "verified" ? { ...patch, auditStatus: "flagged" } : patch;
    try {
      const merged = await patchListing(id, finalPatch);
      setListings((prev) => prev.map((l) => (l.id === id ? merged : l)));
    } catch (e) {
      console.error("updateListingInfo error", e);
      showToast("Could not save — please retry.");
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, fontFamily: SANS, color: COLORS.ink }}>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; }
        ::selection { background: ${COLORS.chalkSoft}; color: ${COLORS.ink}; }
      `}</style>
      <ListFormStyle />

      {/* Header */}
      <header style={{ borderBottom: `1px solid ${COLORS.line}`, background: COLORS.panel, position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 1040, margin: "0 auto", padding: "18px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 6, background: COLORS.brass, display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: "#fff", fontFamily: SERIF }}>
              S
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: -0.3, fontFamily: SERIF }}>SharedClassrooms</div>
            <div style={{ fontSize: 12, color: COLORS.inkSoft }}>spare classrooms, matched to tutors — Singapore</div>
          </div>
          <nav style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[
              ["browse", "Browse rooms"],
              ["list", "List your space"],
              ["manage", "Manage listing"],
              ["admin", "Admin"],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  padding: "8px 14px",
                  borderRadius: 4,
                  border: "none",
                  background: tab === key ? COLORS.ink : "transparent",
                  color: tab === key ? "#fff" : COLORS.inkSoft,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: "pointer",
                  fontFamily: SANS,
                }}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 1040, margin: "0 auto", padding: "28px 20px 80px" }}>
        {loading ? (
          <div style={{ padding: 40, color: COLORS.inkSoft }}>Loading…</div>
        ) : tab === "browse" ? (
          <Browse listings={visibleListings} onInquire={addInquiry} showToast={showToast} />
        ) : tab === "list" ? (
          <ListSpace centers={centers} listings={listings} addCenter={addCenter} addListing={addListing} showToast={showToast} />
        ) : tab === "manage" ? (
          <ManageListing
            centers={centers}
            listings={listings}
            updateCenterInfo={updateCenterInfo}
            updateListingInfo={updateListingInfo}
            addListing={addListing}
            showToast={showToast}
          />
        ) : (
          <Admin
            unlocked={adminUnlocked}
            pw={adminPw}
            setPw={setAdminPw}
            unlock={() => {
              if (adminPw === "sharedclassrooms2026") setAdminUnlocked(true);
              else showToast("Wrong passcode.");
            }}
            centers={centers}
            listings={listings}
            inquiries={inquiries}
            centerById={centerById}
            setListingAudit={setListingAudit}
            setCenterStanding={setCenterStanding}
            setInquiryStatus={setInquiryStatus}
          />
        )}
      </main>

      <footer style={{ borderTop: `1px solid ${COLORS.line}`, padding: "18px 20px", textAlign: "center" }}>
        <a href="/privacy.html" style={{ fontSize: 12.5, color: COLORS.inkSoft, marginRight: 16, textDecoration: "none" }}>
          Privacy Policy
        </a>
        <a href="/terms.html" style={{ fontSize: 12.5, color: COLORS.inkSoft, textDecoration: "none" }}>
          Terms of Service
        </a>
      </footer>

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: COLORS.ink,
            color: "#fff",
            padding: "10px 18px",
            borderRadius: 6,
            fontSize: 13,
            boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

// ================= BROWSE =================
function formatMinBooking(l) {
  return Number(l.minBookingHours) || 2;
}

const TRANSFER_LABELS = {
  direct: "Direct walk, no transfer",
  bus: "Bus needed",
  multiple: "Multiple transfers needed",
};

function formatFullAddress(center) {
  if (!center) return "";
  const postal = center.postalCode ? ` Singapore ${center.postalCode}` : "";
  return `${center.address || ""}${postal}`;
}

function formatMrtSummary(center) {
  if (!center || !center.nearestMrt || !center.mrtWalkMinutes) return null;
  const transfer = TRANSFER_LABELS[center.transferRequired];
  return `Nearest MRT: ${center.mrtWalkMinutes} minutes from ${center.nearestMrt}${transfer ? ` (${transfer})` : ""}`;
}

function Browse({ listings, onInquire, showToast }) {
  const [area, setArea] = useState("");
  const [minCap, setMinCap] = useState("");
  const [maxRate, setMaxRate] = useState("");
  const [activeInquiry, setActiveInquiry] = useState(null);

  const filtered = listings.filter((l) => {
    const addr = `${l.center?.address || ""} ${l.center?.postalCode || ""}`.toLowerCase();
    if (area && !addr.includes(area.toLowerCase())) return false;
    if (minCap && Number(l.capacity) < Number(minCap)) return false;
    if (maxRate && Number(l.pricePerHour) > Number(maxRate)) return false;
    return true;
  });

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 28, margin: "0 0 6px", fontFamily: SERIF, fontWeight: 600 }}>Find a classroom by the slot</h1>
        <p style={{ color: COLORS.inkSoft, margin: 0, fontSize: 14 }}>
          Every room is physically checked before it's listed. Bookings run a minimum of 2 hours.
        </p>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap", background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 4, padding: 14 }}>
        <input style={{ ...inputStyle, maxWidth: 220 }} placeholder="Area / postal code" value={area} onChange={(e) => setArea(e.target.value)} />
        <input style={{ ...inputStyle, maxWidth: 160 }} placeholder="Min capacity" type="number" value={minCap} onChange={(e) => setMinCap(e.target.value)} />
        <input style={{ ...inputStyle, maxWidth: 170 }} placeholder="Max $ / hour" type="number" value={maxRate} onChange={(e) => setMaxRate(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: COLORS.inkSoft, border: `1px dashed ${COLORS.line}`, borderRadius: 4 }}>
          No verified rooms match yet. Once a center lists a room and it's audited, it'll show up here.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {filtered.map((l) => (
            <ListingCard key={l.id} listing={l} onInquire={() => setActiveInquiry(l)} />
          ))}
        </div>
      )}

      {activeInquiry && (
        <InquiryModal
          listing={activeInquiry}
          onClose={() => setActiveInquiry(null)}
          onSubmit={async (payload) => {
            await onInquire({ listingId: activeInquiry.id, ...payload });
            setActiveInquiry(null);
            showToast("Inquiry sent — the center will confirm with you directly.");
          }}
        />
      )}
    </div>
  );
}

function PhotoCarousel({ photos, alt }) {
  const [index, setIndex] = useState(0);
  if (!photos || photos.length === 0) {
    return (
      <div style={{ height: 120, background: `linear-gradient(135deg, ${COLORS.brass}33, ${COLORS.chalk}22)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: COLORS.inkSoft }}>
        No photo uploaded
      </div>
    );
  }
  return (
    <div style={{ position: "relative", height: 120 }}>
      <img src={photos[index]} alt={alt} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      {photos.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => setIndex((i) => (i - 1 + photos.length) % photos.length)}
            style={{ position: "absolute", left: 6, top: "50%", transform: "translateY(-50%)", background: "rgba(28,43,58,0.55)", color: "#fff", border: "none", borderRadius: "50%", width: 24, height: 24, cursor: "pointer", fontSize: 13, lineHeight: 1 }}
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => setIndex((i) => (i + 1) % photos.length)}
            style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "rgba(28,43,58,0.55)", color: "#fff", border: "none", borderRadius: "50%", width: 24, height: 24, cursor: "pointer", fontSize: 13, lineHeight: 1 }}
          >
            ›
          </button>
          <div style={{ position: "absolute", bottom: 6, left: 0, right: 0, textAlign: "center", fontSize: 11, color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,0.5)" }}>
            {index + 1} / {photos.length}
          </div>
        </>
      )}
    </div>
  );
}

function ListingCard({ listing, onInquire }) {
  const badge = AUDIT_LABEL[listing.auditStatus];
  const availability = scheduleSummary(listing.schedule);
  return (
    <div style={{ border: `1px solid ${COLORS.line}`, borderRadius: 6, background: COLORS.panel, overflow: "hidden" }}>
      <PhotoCarousel photos={listing.photos} alt={listing.roomName} />
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, fontFamily: SERIF }}>{listing.roomName}</div>
            <div style={{ fontSize: 12.5, color: COLORS.inkSoft }}>
              {listing.center?.centerName} · {formatFullAddress(listing.center)}
            </div>
            {formatMrtSummary(listing.center) && (
              <div style={{ fontSize: 12.5, color: COLORS.ink, fontWeight: 600, marginTop: 2 }}>
                {formatMrtSummary(listing.center)}
              </div>
            )}
          </div>
          <Badge label={badge.text} bg={badge.bg} fg={badge.fg} />
        </div>
        <div style={{ display: "flex", gap: 14, margin: "10px 0", fontSize: 13, flexWrap: "wrap" }}>
          <span>Up to {listing.capacity} pax</span>
          <span>·</span>
          <span>${listing.pricePerHour}/hr</span>
          <span>·</span>
          <span>{formatMinBooking(listing)}h min</span>
        </div>
        {availability && <div style={{ fontSize: 12, color: COLORS.inkSoft, marginBottom: 6 }}>{availability}</div>}
        {listing.amenities?.length > 0 && (
          <div style={{ fontSize: 12, color: COLORS.inkSoft, marginBottom: 8 }}>{listing.amenities.join(", ")}</div>
        )}
        {listing.siteTourVideoUrl && (
          <div style={{ marginBottom: 8 }}>
            <a href={listing.siteTourVideoUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.chalk, textDecoration: "none" }}>
              ▶ Watch site tour from audit
            </a>
          </div>
        )}
        {listing.calendarBookingUrl && (
          <div style={{ marginBottom: 12 }}>
            <a href={listing.calendarBookingUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.chalk, textDecoration: "none" }}>
              📅 Check live availability & book
            </a>
          </div>
        )}
        <Button variant="accent" onClick={onInquire}>
          Inquire to book
        </Button>
      </div>
    </div>
  );
}

const COMMITMENT_OPTIONS = [
  { value: "1_month", label: "1 month (trial)" },
  { value: "3_months", label: "3 months" },
  { value: "6_months", label: "6 months" },
  { value: "9_months", label: "9 months" },
  { value: "12_months", label: "12 months" },
  { value: "ongoing", label: "Ongoing — not sure yet" },
];

function slotDurationHours(from, to) {
  if (!from || !to) return null;
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  return (th * 60 + tm - (fh * 60 + fm)) / 60;
}

// Soft check only — the listing's own advertised hours are a reference
// point, not a hard boundary, since real availability is often more
// flexible than what's on file and this is exactly the kind of thing a
// tutor and center can sort out directly.
function slotAvailabilityWarning(listing, day, from, to) {
  const daySchedule = listing.schedule?.[day];
  if (!daySchedule?.on) {
    return `${listing.roomName} isn't listed as available on ${day}s — worth confirming with the center directly.`;
  }
  if (from && to && (from < daySchedule.from || to > daySchedule.to)) {
    return `This falls outside ${listing.roomName}'s advertised ${day} hours (${daySchedule.from}–${daySchedule.to}) — worth confirming with the center directly.`;
  }
  return null;
}

function slotSummary(slots) {
  return slots.map((s) => `${s.day} ${s.from}–${s.to}`).join(", ");
}

function InquiryModal({ listing, onClose, onSubmit }) {
  const minHours = formatMinBooking(listing);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [startDate, setStartDate] = useState("");
  const [commitmentLength, setCommitmentLength] = useState("3_months");
  const [slots, setSlots] = useState([{ id: uid(), day: "Mon", from: "", to: "" }]);
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState({});

  const updateSlot = (id, field, value) =>
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)));

  const addSlot = () => setSlots((prev) => [...prev, { id: uid(), day: "Mon", from: "", to: "" }]);

  const removeSlot = (id) => setSlots((prev) => (prev.length > 1 ? prev.filter((s) => s.id !== id) : prev));

  const submit = () => {
    const next = {};
    if (!name.trim()) next.name = "Required";
    if (!contact.trim()) next.contact = "Required";
    if (!startDate) next.startDate = "Required";

    const slotErrors = {};
    slots.forEach((s) => {
      if (!s.from || !s.to) {
        slotErrors[s.id] = "Set both a start and end time";
        return;
      }
      const dur = slotDurationHours(s.from, s.to);
      if (dur <= 0) slotErrors[s.id] = "End time must be after start time";
      else if (dur < minHours) slotErrors[s.id] = `Minimum booking for this room is ${minHours} hours — this slot is only ${dur}h`;
    });
    if (Object.keys(slotErrors).length) next.slots = slotErrors;

    setErrors(next);
    if (Object.keys(next).length) return;

    onSubmit({
      tutorName: name,
      tutorContact: contact,
      startDate,
      commitmentLength,
      slots: slots.map(({ day, from, to }) => ({ day, from, to })),
      notes,
    });
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(28,43,58,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50, overflowY: "auto" }} onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: 8, padding: 24, maxWidth: 480, width: "100%", margin: "20px 0" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 2, fontFamily: SERIF }}>Request to book</div>
        <div style={{ fontSize: 13, color: COLORS.inkSoft, marginBottom: 16 }}>
          {listing.roomName} · {listing.center?.centerName}
        </div>

        <Field label="Your name" error={errors.name}>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Phone or email" error={errors.contact}>
          <input style={inputStyle} value={contact} onChange={(e) => setContact(e.target.value)} />
        </Field>

        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Field label="Preferred start date" error={errors.startDate}>
              <input type="date" style={inputStyle} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="How long do you plan to book for?">
              <select style={inputStyle} value={commitmentLength} onChange={(e) => setCommitmentLength(e.target.value)}>
                {COMMITMENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        <div style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.inkSoft, margin: "4px 0 8px" }}>
          Weekly time slots — add one row per recurring slot you'd like (e.g. every Monday 3–6pm).
        </div>
        {slots.map((s, idx) => {
          const warning = s.from && s.to ? slotAvailabilityWarning(listing, s.day, s.from, s.to) : null;
          const err = errors.slots?.[s.id];
          return (
            <div key={s.id} style={{ marginBottom: 10, padding: 10, border: `1px solid ${COLORS.line}`, borderRadius: 4 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11.5, color: COLORS.inkSoft, marginBottom: 4 }}>Day</div>
                  <select style={inputStyle} value={s.day} onChange={(e) => updateSlot(s.id, "day", e.target.value)}>
                    {DAYS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11.5, color: COLORS.inkSoft, marginBottom: 4 }}>From</div>
                  <input type="time" style={inputStyle} value={s.from} onChange={(e) => updateSlot(s.id, "from", e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11.5, color: COLORS.inkSoft, marginBottom: 4 }}>To</div>
                  <input type="time" style={inputStyle} value={s.to} onChange={(e) => updateSlot(s.id, "to", e.target.value)} />
                </div>
                {slots.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeSlot(s.id)}
                    style={{ border: "none", background: "none", color: COLORS.danger, fontSize: 18, cursor: "pointer", paddingBottom: 6 }}
                    title="Remove this slot"
                  >
                    ×
                  </button>
                )}
              </div>
              {err && <div style={{ fontSize: 12, color: COLORS.danger, marginTop: 6 }}>{err}</div>}
              {!err && warning && <div style={{ fontSize: 12, color: COLORS.brass, marginTop: 6 }}>{warning}</div>}
            </div>
          );
        })}
        <button
          type="button"
          onClick={addSlot}
          style={{ width: "100%", padding: 10, border: `1px dashed ${COLORS.line}`, borderRadius: 4, background: "none", color: COLORS.chalk, fontWeight: 600, fontSize: 13.5, cursor: "pointer", marginBottom: 14 }}
        >
          + Add another time slot
        </button>

        <Field label="Notes (optional)">
          <textarea style={{ ...inputStyle, minHeight: 60 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <Button onClick={submit}>Send inquiry</Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

// Reads a selected image file, downscales it, and returns a compressed
// JPEG Blob ready to upload to Supabase Storage. Deliberately modest
// dimensions/quality so uploads stay fast on a phone connection.
function compressImageFile(file, maxDim = 1200, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not read image"));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height >= width && height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Could not process image"))),
          "image/jpeg",
          quality
        );
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Multiple photos per classroom, backed by real files in Supabase Storage
// rather than data embedded in the row — this is what actually supports
// more than one photo without bloating a single database record.
function MultiPhotoUploadField({ photos, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = React.useRef(null);

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true);
    setError("");
    try {
      const uploaded = [];
      for (const file of files) {
        const blob = await compressImageFile(file);
        const url = await uploadClassroomPhoto(blob);
        uploaded.push(url);
      }
      onChange([...photos, ...uploaded]);
    } catch (err) {
      console.error("photo upload error", err);
      setError("Couldn't upload one or more photos — check your connection and try again.");
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const removePhoto = async (url) => {
    onChange(photos.filter((p) => p !== url));
    try {
      await deleteClassroomPhoto(url);
    } catch (err) {
      // Not fatal — the photo's already removed from this listing either way.
      console.error("photo delete error", err);
    }
  };

  return (
    <div className="sc-form-photo">
      {photos.length > 0 && (
        <div className="sc-form-photo-grid">
          {photos.map((url) => (
            <div className="sc-form-photo-thumb" key={url}>
              <img src={url} alt="Classroom" />
              <button type="button" className="sc-form-photo-remove" onClick={() => removePhoto(url)} title="Remove photo">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <label className="sc-form-photo-upload">
        <input ref={inputRef} type="file" accept="image/*" multiple onChange={handleFiles} style={{ display: "none" }} />
        {busy ? "Uploading…" : "Add photos"}
      </label>
      {error && <div className="sc-form-note" style={{ color: COLORS.danger }}>{error}</div>}
    </div>
  );
}

// Shared classroom form fields, used by both the intake form (ListSpace)
// and the "add a classroom to my existing center" flow inside the
// authenticated Manage Listing screen — one definition, so the two never
// drift apart.
function ClassroomFields({ classroom: c, errors: err, onUpdate, onToggleScheduleDay, onSetScheduleTime, onToggleAmenity }) {
  return (
    <>
      <div className="sc-form-grid">
        <Field label="Capacity (seats)" error={err.capacity}>
          <input type="number" min={1} value={c.capacity} onChange={(e) => onUpdate("capacity", e.target.value)} />
        </Field>
        <Field label="Price per hour (SGD)" error={err.pricePerHour}>
          <input type="number" min={0} value={c.pricePerHour} onChange={(e) => onUpdate("pricePerHour", e.target.value)} />
        </Field>
        <Field label="Minimum booking (hours)" error={err.minBookingHours}>
          <input type="number" min={2} value={c.minBookingHours} onChange={(e) => onUpdate("minBookingHours", e.target.value)} />
        </Field>
      </div>

      <ScheduleGrid schedule={c.schedule} error={err.schedule} onToggleDay={onToggleScheduleDay} onTimeChange={onSetScheduleTime} />

      <Field label="Amenities">
        <AmenityPicker amenities={c.amenities} onToggle={onToggleAmenity} />
      </Field>

      <div className="sc-form-grid">
        <Field label="Long-term booking discount?">
          <label className="sc-form-check">
            <input type="checkbox" checked={c.longTermDiscount} onChange={(e) => onUpdate("longTermDiscount", e.target.checked)} />
            Yes, offer a discount
          </label>
        </Field>
        <Field label="Security deposit?">
          <label className="sc-form-check">
            <input type="checkbox" checked={c.hasDeposit} onChange={(e) => onUpdate("hasDeposit", e.target.checked)} />
            Yes, a deposit applies
          </label>
          {c.hasDeposit && (
            <input type="number" placeholder="Deposit amount (SGD)" value={c.deposit} onChange={(e) => onUpdate("deposit", e.target.value)} />
          )}
        </Field>
      </div>

      <Field label="Toilet access">
        <select value={c.toiletType} onChange={(e) => onUpdate("toiletType", e.target.value)}>
          <option value="">Select one</option>
          <option value="common_center">Common, within center</option>
          <option value="common_building">Shared building common toilet</option>
        </select>
      </Field>

      <Field label="Additional fees (optional)">
        <input placeholder="e.g. cleaning, maintenance" value={c.additionalFees} onChange={(e) => onUpdate("additionalFees", e.target.value)} />
      </Field>

      <Field label="Photos (optional)" hint="Add as many as you'd like — phone photos are fine, they're compressed automatically. Just representative shots for now; we'll capture the full site tour at audit.">
        <MultiPhotoUploadField photos={c.photos} onChange={(photos) => onUpdate("photos", photos)} />
      </Field>
    </>
  );
}

// ================= LIST YOUR SPACE =================
function ListSpace({ centers, listings, addCenter, addListing, showToast }) {
  const [step, setStep] = useState(0);
  const [center, setCenter] = useState(emptyCenterInfo);
  const [classrooms, setClassrooms] = useState([emptyClassroom()]);
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [lastSubmitCount, setLastSubmitCount] = useState(0);

  // Always labelled from Classroom A — a brand-new center has no existing
  // listings to continue a sequence from. Adding more classrooms to an
  // already-registered center happens through Manage Listing instead, where
  // Google Sign-In actually proves the person belongs to that center; this
  // page never trusts an unauthenticated claim of "I already have a center."
  const labelFor = (idx) => `Classroom ${classroomLetter(idx)}`;

  const readiness = React.useMemo(() => computeReadiness(center, classrooms), [center, classrooms]);
  const suggestions = React.useMemo(() => buildSuggestions(center, classrooms, readiness, labelFor), [center, classrooms, readiness]);

  const updateCenter = (field, value) => setCenter((prev) => ({ ...prev, [field]: value }));

  const updateClassroom = (id, field, value) =>
    setClassrooms((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));

  const toggleScheduleDay = (id, day) =>
    setClassrooms((prev) =>
      prev.map((c) => (c.id === id ? { ...c, schedule: { ...c.schedule, [day]: toggledDay(c.schedule[day]) } } : c))
    );

  const setScheduleTime = (id, day, field, value) =>
    setClassrooms((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, schedule: { ...c.schedule, [day]: { ...c.schedule[day], [field]: value } } } : c
      )
    );

  const toggleAmenity = (id, item) =>
    setClassrooms((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, amenities: c.amenities.includes(item) ? c.amenities.filter((a) => a !== item) : [...c.amenities, item] } : c
      )
    );

  const toggleExpanded = (id) => setClassrooms((prev) => prev.map((c) => (c.id === id ? { ...c, expanded: !c.expanded } : c)));

  const addClassroom = () => setClassrooms((prev) => [...prev.map((c) => ({ ...c, expanded: false })), emptyClassroom()]);

  const removeClassroom = (id) => setClassrooms((prev) => (prev.length > 1 ? prev.filter((c) => c.id !== id) : prev));

  const validateStep0 = () => {
    const req = ["centerName", "contactName", "phone", "email", "postalCode"];
    const next = {};
    req.forEach((f) => {
      if (!center[f]?.trim()) next[f] = "Required";
    });

    // Catches the "I forgot I already registered" case before a duplicate
    // center gets created — email is a much stronger identity signal than
    // address, which can vary in formatting or change if a center moves.
    if (center.email?.trim()) {
      const dupe = centers.find((c) => (c.email || "").trim().toLowerCase() === center.email.trim().toLowerCase());
      if (dupe) {
        next.email = `"${dupe.centerName}" is already registered with this email. If that's you, use Manage Listing to add a classroom instead of registering again.`;
      }
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const validateStep1 = () => {
    const next = {};
    classrooms.forEach((c) => {
      const e = {};
      if (!c.capacity) e.capacity = "Required";
      const activeDays = DAYS.filter((d) => c.schedule[d].on);
      if (!activeDays.length) e.schedule = "Pick at least one day";
      else if (activeDays.some((d) => !c.schedule[d].from || !c.schedule[d].to)) e.schedule = "Set a time range for each day you selected";
      if (!c.pricePerHour) e.pricePerHour = "Required";
      if (Number(c.minBookingHours) < 2) e.minBookingHours = "Minimum is 2 hours";
      if (Object.keys(e).length) next[c.id] = e;
    });
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const goNext = () => {
    if (step === 0 && !validateStep0()) return;
    if (step === 1 && !validateStep1()) return;
    setErrors({});
    setStep((s) => Math.min(s + 1, LIST_STEPS.length - 1));
  };

  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  const handleFinalSubmit = async () => {
    // Flag (never auto-merge) a brand-new center whose address matches a
    // DIFFERENT existing center — Admin checks whether it's shared premises
    // or an unrelated coincidence, rather than the system deciding.
    let addressMatchWarning = null;
    const addr = center.address.trim().toLowerCase();
    const postal = center.postalCode.trim();
    if (addr || postal) {
      const match = centers.find(
        (c) => (c.address || "").trim().toLowerCase() === addr && (c.postalCode || "").trim() === postal && addr
      );
      if (match) {
        addressMatchWarning = `Address matches an existing center on file: "${match.centerName}" — check whether this is shared/duplicate premises.`;
      }
    }
    const centerId = await addCenter({
      centerName: center.centerName,
      contactName: center.contactName,
      phone: center.phone,
      email: center.email,
      address: center.address,
      postalCode: center.postalCode,
      website: center.website,
      description: center.description,
      nearestMrt: center.nearestMrt,
      mrtWalkMinutes: center.mrtWalkMinutes,
      transferRequired: center.transferRequired,
      cleaningFrequency: center.cleaningFrequency,
      canPutUpPoster: center.canPutUpPoster,
      jointMarketing: center.jointMarketing,
      marketingNotes: center.marketingNotes,
    });

    for (let idx = 0; idx < classrooms.length; idx++) {
      const c = classrooms[idx];
      await addListing({
        centerId,
        roomName: labelFor(idx),
        capacity: c.capacity,
        pricePerHour: c.pricePerHour,
        minBookingHours: c.minBookingHours,
        schedule: c.schedule,
        longTermDiscount: c.longTermDiscount,
        hasDeposit: c.hasDeposit,
        deposit: c.deposit,
        additionalFees: c.additionalFees,
        amenities: c.amenities,
        toiletType: c.toiletType,
        photos: c.photos,
        readinessScoreAtSubmission: readiness.overall,
        addressMatchWarning,
      });
    }

    showToast("Listing submitted — it'll go live once we've visited and verified the room.");
    setLastSubmitCount(classrooms.length);
    setSubmitted(true);
  };

  const listAnother = () => {
    setStep(0);
    setExistingCenterId("");
    setCenter(emptyCenterInfo);
    setClassrooms([emptyClassroom()]);
    setErrors({});
    setSubmitted(false);
  };

  if (submitted) {
    return (
      <div className="sc-form-root">
        <div className="sc-form-success">
          <div className="sc-form-success-mark">✓</div>
          <h2>Listing received</h2>
          <p>
            Thanks — we've logged {lastSubmitCount} classroom{lastSubmitCount > 1 ? "s" : ""} for {center.centerName}.
            A member of the SharedClassrooms team will visit in person to verify the space before it goes live.
            We'll capture the site tour video — and set up your Google Calendar booking link — during that visit,
            so there's nothing more to do for now.
          </p>
          <p className="sc-form-success-score">
            Your readiness score: <strong>{readiness.overall}/100</strong> · {readiness.tier}
          </p>
          <div style={{ marginTop: 20 }}>
            <Button onClick={listAnother}>List another classroom</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sc-form-root">
      <header className="sc-form-header">
        <h1>List your spare classroom</h1>
        <p className="sc-form-sub">
          Turn empty hours into rental income. Verified tutors book your spare classroom time — no lease, no
          commitment. Every new listing is visited in person before it goes live.
        </p>
      </header>

      <div className="sc-form-body">
        <nav className="sc-form-rail" aria-label="Form progress">
          {LIST_STEPS.map((label, i) => (
            <div key={label} className={"sc-form-rail-step" + (i === step ? " is-active" : "") + (i < step ? " is-done" : "")}>
              <span className="sc-form-rail-dot">{i < step ? "✓" : i + 1}</span>
              <span>{label}</span>
            </div>
          ))}
          {step < 2 && (
            <div className="sc-form-rail-score">
              <div className="sc-form-rail-score-num">{readiness.overall}</div>
              <div className="sc-form-rail-score-label">readiness score so far</div>
              <div className="sc-form-rail-score-bar">
                <div className="sc-form-rail-score-fill" style={{ width: `${readiness.overall}%` }} />
              </div>
              <div className="sc-form-rail-score-hint">Fill in more details to raise it</div>
            </div>
          )}
        </nav>

        <div className="sc-form-panel">
          {step === 0 && (
            <section>
              <h2>About your center</h2>
              <p className="sc-form-hint">
                Already registered and just want to add another classroom? Do that from{" "}
                <strong>Manage listing</strong> instead, once you've signed in — that keeps it tied to your actual
                account rather than anyone being able to add listings under your center's name.
              </p>

              <div className="sc-form-grid">
                <Field label="Name of tuition center" error={errors.centerName}>
                  <input value={center.centerName} onChange={(e) => updateCenter("centerName", e.target.value)} />
                </Field>
                <Field label="Contact person" error={errors.contactName}>
                  <input value={center.contactName} onChange={(e) => updateCenter("contactName", e.target.value)} />
                </Field>
                <Field label="Phone number" error={errors.phone}>
                  <input type="tel" value={center.phone} onChange={(e) => updateCenter("phone", e.target.value)} />
                </Field>
                <Field label="Email" error={errors.email}>
                  <input type="email" value={center.email} onChange={(e) => updateCenter("email", e.target.value)} />
                </Field>
                <Field label="Address">
                  <input value={center.address} onChange={(e) => updateCenter("address", e.target.value)} />
                </Field>
                <Field label="Postal code" error={errors.postalCode}>
                  <input value={center.postalCode} onChange={(e) => updateCenter("postalCode", e.target.value)} />
                </Field>
                <Field label="Website (optional)">
                  <input value={center.website} onChange={(e) => updateCenter("website", e.target.value)} />
                </Field>
              </div>
              <Field label="Brief introduction of your center (optional)">
                <textarea rows={3} value={center.description} onChange={(e) => updateCenter("description", e.target.value)} />
              </Field>

              <h2 className="sc-form-subheading">Getting here & upkeep</h2>
              <p className="sc-form-hint">These feed your readiness score — they help us tell you how marketplace-ready your center is, and how to improve it.</p>
              <div className="sc-form-grid">
                <Field label="Nearest MRT station">
                  <input value={center.nearestMrt} onChange={(e) => updateCenter("nearestMrt", e.target.value)} />
                </Field>
                <Field label="Walk time from that MRT (minutes)">
                  <input type="number" min={0} value={center.mrtWalkMinutes} onChange={(e) => updateCenter("mrtWalkMinutes", e.target.value)} />
                </Field>
                <Field label="Getting from MRT to your center">
                  <select value={center.transferRequired} onChange={(e) => updateCenter("transferRequired", e.target.value)}>
                    <option value="">Select one</option>
                    <option value="direct">Direct walk, no transfer</option>
                    <option value="bus">Bus needed</option>
                    <option value="multiple">Multiple transfers needed</option>
                  </select>
                </Field>
                <Field label="How often is the space cleaned?">
                  <select value={center.cleaningFrequency} onChange={(e) => updateCenter("cleaningFrequency", e.target.value)}>
                    <option value="">Select one</option>
                    <option value="daily">Daily</option>
                    <option value="few_weekly">2–3 times a week</option>
                    <option value="weekly">Weekly</option>
                    <option value="adhoc">Ad-hoc / on request</option>
                  </select>
                </Field>
              </div>

              <Field label="Marketing support">
                <label className="sc-form-check">
                  <input type="checkbox" checked={center.canPutUpPoster} onChange={(e) => updateCenter("canPutUpPoster", e.target.checked)} />
                  Tutors can put up a small SharedClassrooms poster on-site
                </label>
                <label className="sc-form-check">
                  <input type="checkbox" checked={center.jointMarketing} onChange={(e) => updateCenter("jointMarketing", e.target.checked)} />
                  Open to occasional joint marketing (shared posts, etc.)
                </label>
              </Field>
              <Field
                label="Other marketing ideas (optional)"
                hint="Anything beyond the checkboxes above — e.g. a referral program, an open house, social media you'd co-post on, or a discount for a tutor's first booking."
              >
                <textarea
                  rows={3}
                  value={center.marketingNotes}
                  onChange={(e) => updateCenter("marketingNotes", e.target.value)}
                />
              </Field>
            </section>
          )}

          {step === 1 && (
            <section>
              <h2>Your classrooms</h2>
              <p className="sc-form-hint">Add each room you'd like to list — each is auto-labelled Classroom A, B, C… in the order you add them.</p>

              {classrooms.map((c, idx) => {
                const err = errors[c.id] || {};
                return (
                  <div className="sc-form-card" key={c.id}>
                    <button type="button" className="sc-form-card-head" onClick={() => toggleExpanded(c.id)}>
                      <span>
                        {labelFor(idx)}
                        {!c.expanded && c.capacity ? ` · Seats ${c.capacity}${c.pricePerHour ? ` · $${c.pricePerHour}/hr` : ""}` : ""}
                      </span>
                      <span className="sc-form-chevron">{c.expanded ? "–" : "+"}</span>
                    </button>

                    {c.expanded && (
                      <div className="sc-form-card-body">
                        <ClassroomFields
                          classroom={c}
                          errors={err}
                          onUpdate={(field, value) => updateClassroom(c.id, field, value)}
                          onToggleScheduleDay={(day) => toggleScheduleDay(c.id, day)}
                          onSetScheduleTime={(day, field, value) => setScheduleTime(c.id, day, field, value)}
                          onToggleAmenity={(item) => toggleAmenity(c.id, item)}
                        />

                        {classrooms.length > 1 && (
                          <button type="button" className="sc-form-remove" onClick={() => removeClassroom(c.id)}>
                            Remove this classroom
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              <button type="button" className="sc-form-add" onClick={addClassroom}>
                + Add another classroom
              </button>
            </section>
          )}

          {step === 2 && (
            <section>
              <h2>Your readiness report</h2>
              <ReadinessReport readiness={readiness} suggestions={suggestions} />

              <h2 className="sc-form-subheading">Review your listing</h2>
              <div className="sc-form-review-block">
                <h3>{center.centerName || "Untitled center"}</h3>
                <p className="sc-form-review-line">
                  {center.contactName} · {center.phone} · {center.email}
                </p>
                <p className="sc-form-review-line">
                  {center.address}
                  {center.address ? ", " : ""}
                  {center.postalCode}
                </p>
                {center.website && <p className="sc-form-review-line">{center.website}</p>}
              </div>

              {classrooms.map((c, idx) => (
                <div className="sc-form-review-block" key={c.id}>
                  <h3>{labelFor(idx)}</h3>
                  <p className="sc-form-review-line">
                    Seats {c.capacity || "—"} · ${c.pricePerHour || "—"}/hr · {c.minBookingHours}h minimum
                  </p>
                  <p className="sc-form-review-line">{scheduleSummary(c.schedule) || "No days selected"}</p>
                  <p className="sc-form-review-line">{c.amenities.length ? c.amenities.join(", ") : "No amenities selected"}</p>
                </div>
              ))}

              <p className="sc-form-note">
                By submitting, you agree your listing stays hidden from tutors until a SharedClassrooms team member
                visits in person to verify it.
              </p>
            </section>
          )}

          <div className="sc-form-actions">
            {step > 0 && (
              <button type="button" className="sc-form-btn-ghost" onClick={goBack}>
                Back
              </button>
            )}
            {step < LIST_STEPS.length - 1 ? (
              <button type="button" className="sc-form-btn" onClick={goNext}>
                Continue
              </button>
            ) : (
              <button type="button" className="sc-form-btn" onClick={handleFinalSubmit}>
                Submit listing
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReadinessReport({ readiness, suggestions }) {
  return (
    <div className="sc-form-report">
      <div className="sc-form-report-headline">
        <div className="sc-form-report-score">{readiness.overall}</div>
        <div>
          <div className="sc-form-report-tier">{readiness.tier}</div>
          <div className="sc-form-report-tier-sub">out of 100 points</div>
        </div>
      </div>

      <div className="sc-form-report-bars">
        {readiness.categories.map((cat) => (
          <div className="sc-form-report-row" key={cat.key}>
            <div className="sc-form-report-row-top">
              <span>{cat.label}</span>
              <span>
                {Math.round(cat.score)}/{cat.max}
              </span>
            </div>
            <div className="sc-form-report-track">
              <div className="sc-form-report-fill" style={{ width: `${(cat.score / cat.max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>

      {suggestions.length > 0 && (
        <div className="sc-form-report-tips">
          <div className="sc-form-report-tips-label">Ways to raise your score</div>
          <ul>
            {suggestions.map((tip, i) => (
              <li key={i}>{tip}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="sc-form-note">
        Price benchmark is based on publicly listed Singapore tuition classroom rentals as of mid-2026 — a reference
        point, not a rule. Actual demand for your space may differ.
      </p>
    </div>
  );
}

// ================= MANAGE LISTING =================
// A center looks itself up (phone + email) and can then edit. Self-reported
// fields save immediately; physically-verified fields push a verified
// listing back to "flagged" for a quick re-check.
// Google's multicolor "G" mark, per their brand guidelines, so the button
// reads as genuinely theirs rather than a generic OAuth button.
function GoogleGlyph({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" style={{ display: "block" }}>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.87 2.7-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.03z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .98 4.97L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z" />
    </svg>
  );
}

function GoogleSignInButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 20px 10px 14px",
        borderRadius: 4,
        border: `1px solid ${COLORS.line}`,
        background: "#fff",
        color: "#3C4043",
        fontFamily: "'Roboto', Arial, sans-serif",
        fontSize: 14,
        fontWeight: 500,
        cursor: "pointer",
        boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
      }}
    >
      <GoogleGlyph />
      Sign in with Google
    </button>
  );
}

// Stands in for Google's real account chooser — this app has no registered
// OAuth client yet, so this mock lets Jason see and click through the
// interaction now. Swapping in the real Google Identity Services button is
// a drop-in replacement once the one-time OAuth setup is done.
function GoogleAccountPickerMock({ suggestions, onChoose, onClose }) {
  const [email, setEmail] = useState("");
  const uniqueSuggestions = [...new Set(suggestions)].slice(0, 4);

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(28,43,58,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 60 }}
      onClick={onClose}
    >
      <div
        style={{ background: "#fff", borderRadius: 8, padding: 0, maxWidth: 360, width: "100%", boxShadow: "0 8px 28px rgba(0,0,0,0.25)", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "24px 24px 16px", textAlign: "center", fontFamily: "'Roboto', Arial, sans-serif" }}>
          <GoogleGlyph size={24} />
          <div style={{ fontSize: 18, marginTop: 12, color: "#202124" }}>Choose an account</div>
          <div style={{ fontSize: 13, color: "#5F6368", marginTop: 4 }}>to continue to SharedClassrooms</div>
        </div>

        {uniqueSuggestions.length > 0 && (
          <div style={{ borderTop: "1px solid #e8eaed" }}>
            {uniqueSuggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onChoose(s)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 24px",
                  border: "none",
                  background: "#fff",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "'Roboto', Arial, sans-serif",
                }}
              >
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: COLORS.chalk, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>
                  {s[0].toUpperCase()}
                </div>
                <div style={{ fontSize: 14, color: "#202124" }}>{s}</div>
              </button>
            ))}
          </div>
        )}

        <div style={{ borderTop: "1px solid #e8eaed", padding: "16px 24px" }}>
          <div style={{ fontSize: 12, color: "#5F6368", marginBottom: 8 }}>
            Use another account (preview: type any email to simulate signing in)
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ ...inputStyle, fontFamily: "'Roboto', Arial, sans-serif" }}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && email.trim() && onChoose(email.trim())}
            />
            <Button onClick={() => email.trim() && onChoose(email.trim())}>Go</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Loads Google's Identity Services script once, cached across mounts.
let googleScriptPromise = null;
function loadGoogleScript() {
  if (googleScriptPromise) return googleScriptPromise;
  googleScriptPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Google's sign-in script"));
    document.head.appendChild(script);
  });
  return googleScriptPromise;
}

// The real "Sign in with Google" button, used once VITE_GOOGLE_CLIENT_ID is
// configured. Google's script renders its own genuine button here; on
// sign-in it hands back a signed ID token, which gets sent to the
// verify-google-signin Netlify function — never trusted on its own, since
// anything read client-side without checking the signature could be faked.
function RealGoogleSignInButton({ clientId, onVerifiedEmail, onError }) {
  const buttonRef = React.useRef(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    loadGoogleScript()
      .then(() => {
        if (cancelled) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async (response) => {
            try {
              const res = await fetch("/.netlify/functions/verify-google-signin", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id_token: response.credential }),
              });
              const data = await res.json();
              if (!res.ok) {
                onError(data.error || "Sign-in could not be verified.");
                return;
              }
              onVerifiedEmail(data.email);
            } catch (e) {
              console.error("google verify error", e);
              onError("Could not verify sign-in — check your connection and try again.");
            }
          },
        });
        if (buttonRef.current) {
          window.google.accounts.id.renderButton(buttonRef.current, {
            theme: "outline",
            size: "large",
            text: "signin_with",
            width: 280,
          });
        }
        setLoading(false);
      })
      .catch((e) => {
        console.error(e);
        onError("Could not load Google's sign-in button — check your connection and try again.");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      {loading && <div className="sc-form-note">Loading Google sign-in…</div>}
      <div ref={buttonRef} />
    </div>
  );
}

function ManageListing({ centers, listings, updateCenterInfo, updateListingInfo, addListing, showToast }) {
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  const [googleEmail, setGoogleEmail] = useState(null); // the "signed in" Google account email
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [verifyError, setVerifyError] = useState("");

  const handleSignedIn = (email) => {
    setPickerOpen(false);
    setVerifyError("");
    setGoogleEmail(email);
    const match = centers.find((c) => (c.email || "").trim().toLowerCase() === email.trim().toLowerCase());
    setNotFound(!match);
  };

  const signOut = () => {
    setGoogleEmail(null);
    setNotFound(false);
    setVerifyError("");
  };

  const center = googleEmail ? centers.find((c) => (c.email || "").trim().toLowerCase() === googleEmail.trim().toLowerCase()) : null;
  const myListings = center ? listings.filter((l) => l.centerId === center.id) : [];

  if (!center) {
    return (
      <div className="sc-form-root" style={{ maxWidth: 440 }}>
        <header className="sc-form-header">
          <h1>Manage your listing</h1>
          <p className="sc-form-sub">Sign in with the Google account you registered with to update your details.</p>
        </header>
        <div className="sc-form-panel" style={{ textAlign: "center" }}>
          {!googleEmail ? (
            <>
              {googleClientId ? (
                <RealGoogleSignInButton clientId={googleClientId} onVerifiedEmail={handleSignedIn} onError={setVerifyError} />
              ) : (
                <GoogleSignInButton onClick={() => setPickerOpen(true)} />
              )}
              {verifyError && (
                <p className="sc-form-note" style={{ color: COLORS.danger, marginTop: 12 }}>
                  {verifyError}
                </p>
              )}
              <p className="sc-form-note" style={{ marginTop: 16 }}>
                We only ever see the email address on your Google account — never your Google password.
              </p>
              {!googleClientId && (
                <p className="sc-form-note" style={{ marginTop: 4 }}>
                  (Preview mode: showing a design mock since no Google Client ID is configured yet.)
                </p>
              )}
            </>
          ) : (
            notFound && (
              <>
                <p className="sc-form-note" style={{ color: COLORS.danger }}>
                  Signed in as <strong>{googleEmail}</strong> — but that doesn't match any center on file. Try a
                  different Google account, or contact us if you believe this is an error.
                </p>
                <button type="button" className="sc-form-btn-ghost" onClick={signOut}>
                  Try a different account
                </button>
              </>
            )
          )}
        </div>
        <p className="sc-form-note" style={{ marginTop: 12 }}>
          {googleClientId
            ? "Signed in with your real Google account, verified server-side before we trust the email it returns."
            : "Preview note: this mocks the Google Sign-In interaction for design review. Wiring it to real Google accounts needs a one-time OAuth setup in Google Cloud Console before it goes live."}
        </p>
        {!googleClientId && pickerOpen && (
          <GoogleAccountPickerMock
            suggestions={centers.map((c) => c.email).filter(Boolean)}
            onChoose={handleSignedIn}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="sc-form-root">
      <header className="sc-form-header">
        <h1>Manage your listing</h1>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <p className="sc-form-sub" style={{ margin: 0 }}>{center.centerName}</p>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: COLORS.inkSoft }}>
            <GoogleGlyph size={16} />
            Signed in as {googleEmail}
            <button type="button" className="sc-form-btn-ghost" style={{ padding: "4px 10px", marginTop: 0 }} onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <div className="sc-form-panel" style={{ marginBottom: 20 }}>
        <ManageCenterSection center={center} updateCenterInfo={updateCenterInfo} showToast={showToast} />
      </div>
      {myListings.map((l) => (
        <div className="sc-form-panel" style={{ marginBottom: 20 }} key={l.id}>
          <ManageListingSection listing={l} updateListingInfo={updateListingInfo} showToast={showToast} />
        </div>
      ))}
      {myListings.length === 0 && <p className="sc-form-note">No classrooms on file for this center yet.</p>}
      <div className="sc-form-panel" style={{ marginBottom: 20 }}>
        <AddClassroomSection center={center} existingCount={myListings.length} addListing={addListing} showToast={showToast} />
      </div>
      <button type="button" className="sc-form-btn-ghost" onClick={signOut}>
        Sign out / switch account
      </button>
    </div>
  );
}

// Adding a classroom to an already-registered center — only reachable after
// real, verified Google Sign-In above. This replaces the old public
// dropdown that let anyone pick an existing center's name and add listings
// under it with no proof of ownership at all.
function AddClassroomSection({ center, existingCount, addListing, showToast }) {
  const [open, setOpen] = useState(false);
  const [classroom, setClassroom] = useState(emptyClassroom());
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const label = `Classroom ${classroomLetter(existingCount)}`;

  const update = (field, value) => setClassroom((prev) => ({ ...prev, [field]: value }));
  const toggleDay = (day) =>
    setClassroom((prev) => ({ ...prev, schedule: { ...prev.schedule, [day]: toggledDay(prev.schedule[day]) } }));
  const setTime = (day, field, value) =>
    setClassroom((prev) => ({ ...prev, schedule: { ...prev.schedule, [day]: { ...prev.schedule[day], [field]: value } } }));
  const toggleAmenity = (item) =>
    setClassroom((prev) => ({
      ...prev,
      amenities: prev.amenities.includes(item) ? prev.amenities.filter((a) => a !== item) : [...prev.amenities, item],
    }));

  const validate = () => {
    const e = {};
    if (!classroom.capacity) e.capacity = "Required";
    const activeDays = DAYS.filter((d) => classroom.schedule[d].on);
    if (!activeDays.length) e.schedule = "Pick at least one day";
    else if (activeDays.some((d) => !classroom.schedule[d].from || !classroom.schedule[d].to)) e.schedule = "Set a time range for each day you selected";
    if (!classroom.pricePerHour) e.pricePerHour = "Required";
    if (Number(classroom.minBookingHours) < 2) e.minBookingHours = "Minimum is 2 hours";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setSaving(true);
    const readiness = computeReadiness(center, [classroom]);
    await addListing({
      centerId: center.id,
      roomName: label,
      capacity: classroom.capacity,
      pricePerHour: classroom.pricePerHour,
      minBookingHours: classroom.minBookingHours,
      schedule: classroom.schedule,
      longTermDiscount: classroom.longTermDiscount,
      hasDeposit: classroom.hasDeposit,
      deposit: classroom.deposit,
      additionalFees: classroom.additionalFees,
      amenities: classroom.amenities,
      toiletType: classroom.toiletType,
      photos: classroom.photos,
      readinessScoreAtSubmission: readiness.overall,
    });
    setSaving(false);
    setClassroom(emptyClassroom());
    setErrors({});
    setOpen(false);
    showToast(`${label} added — it'll go live once visited and verified, same as any new listing.`);
  };

  if (!open) {
    return (
      <button type="button" className="sc-form-add" onClick={() => setOpen(true)}>
        + Add another classroom ({label})
      </button>
    );
  }

  return (
    <section>
      <h2>{label}</h2>
      <p className="sc-form-hint">New classrooms are hidden from Browse until physically verified, same as any first-time listing.</p>
      <ClassroomFields
        classroom={classroom}
        errors={errors}
        onUpdate={update}
        onToggleScheduleDay={toggleDay}
        onSetScheduleTime={setTime}
        onToggleAmenity={toggleAmenity}
      />
      <div style={{ display: "flex", gap: 10 }}>
        <Button onClick={submit} disabled={saving}>
          {saving ? "Adding…" : "Add classroom"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setClassroom(emptyClassroom());
            setErrors({});
          }}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}

function ManageCenterSection({ center, updateCenterInfo, showToast }) {
  const [form, setForm] = useState(center);
  const update = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const save = async () => {
    await updateCenterInfo(center.id, {
      centerName: form.centerName,
      contactName: form.contactName,
      address: form.address,
      postalCode: form.postalCode,
      website: form.website,
      description: form.description,
      nearestMrt: form.nearestMrt,
      mrtWalkMinutes: form.mrtWalkMinutes,
      transferRequired: form.transferRequired,
      cleaningFrequency: form.cleaningFrequency,
      canPutUpPoster: form.canPutUpPoster,
      jointMarketing: form.jointMarketing,
      marketingNotes: form.marketingNotes,
    });
    showToast("Center details updated.");
  };

  return (
    <section>
      <h2>Your center details</h2>
      <p className="sc-form-hint">These update immediately — none of this needs a site visit to confirm.</p>
      <div className="sc-form-grid">
        <Field label="Name of tuition center">
          <input value={form.centerName} onChange={(e) => update("centerName", e.target.value)} />
        </Field>
        <Field label="Contact person">
          <input value={form.contactName} onChange={(e) => update("contactName", e.target.value)} />
        </Field>
        <Field label="Phone" hint="Used to look yourself up — contact us to change it.">
          <input value={form.phone} disabled />
        </Field>
        <Field label="Email" hint="Used to look yourself up — contact us to change it.">
          <input value={form.email} disabled />
        </Field>
        <Field label="Address">
          <input value={form.address} onChange={(e) => update("address", e.target.value)} />
        </Field>
        <Field label="Postal code">
          <input value={form.postalCode} onChange={(e) => update("postalCode", e.target.value)} />
        </Field>
        <Field label="Website (optional)">
          <input value={form.website} onChange={(e) => update("website", e.target.value)} />
        </Field>
        <Field label="Nearest MRT station">
          <input value={form.nearestMrt} onChange={(e) => update("nearestMrt", e.target.value)} />
        </Field>
        <Field label="Walk time from that MRT (minutes)">
          <input type="number" min={0} value={form.mrtWalkMinutes} onChange={(e) => update("mrtWalkMinutes", e.target.value)} />
        </Field>
        <Field label="Getting from MRT to your center">
          <select value={form.transferRequired} onChange={(e) => update("transferRequired", e.target.value)}>
            <option value="">Select one</option>
            <option value="direct">Direct walk, no transfer</option>
            <option value="bus">Bus needed</option>
            <option value="multiple">Multiple transfers needed</option>
          </select>
        </Field>
        <Field label="How often is the space cleaned?">
          <select value={form.cleaningFrequency} onChange={(e) => update("cleaningFrequency", e.target.value)}>
            <option value="">Select one</option>
            <option value="daily">Daily</option>
            <option value="few_weekly">2–3 times a week</option>
            <option value="weekly">Weekly</option>
            <option value="adhoc">Ad-hoc / on request</option>
          </select>
        </Field>
      </div>
      <Field label="Brief introduction of your center (optional)">
        <textarea rows={3} value={form.description} onChange={(e) => update("description", e.target.value)} />
      </Field>
      <Field label="Marketing support">
        <label className="sc-form-check">
          <input type="checkbox" checked={form.canPutUpPoster} onChange={(e) => update("canPutUpPoster", e.target.checked)} />
          Tutors can put up a small SharedClassrooms poster on-site
        </label>
        <label className="sc-form-check">
          <input type="checkbox" checked={form.jointMarketing} onChange={(e) => update("jointMarketing", e.target.checked)} />
          Open to occasional joint marketing (shared posts, etc.)
        </label>
      </Field>
      <Field label="Other marketing ideas (optional)">
        <textarea rows={3} value={form.marketingNotes} onChange={(e) => update("marketingNotes", e.target.value)} />
      </Field>
      <button type="button" className="sc-form-btn" onClick={save}>
        Save center details
      </button>
    </section>
  );
}

function ManageListingSection({ listing, updateListingInfo, showToast }) {
  const [selfForm, setSelfForm] = useState({
    pricePerHour: listing.pricePerHour,
    minBookingHours: listing.minBookingHours,
    schedule: listing.schedule || makeEmptySchedule(),
    longTermDiscount: listing.longTermDiscount,
    hasDeposit: listing.hasDeposit,
    deposit: listing.deposit,
    additionalFees: listing.additionalFees,
    photos: listing.photos || [],
  });
  const [physForm, setPhysForm] = useState({
    capacity: listing.capacity,
    amenities: listing.amenities || [],
    toiletType: listing.toiletType,
  });

  const badge = AUDIT_LABEL[listing.auditStatus];

  const updateSelf = (field, value) => setSelfForm((prev) => ({ ...prev, [field]: value }));
  const toggleSelfDay = (day) =>
    setSelfForm((prev) => ({ ...prev, schedule: { ...prev.schedule, [day]: toggledDay(prev.schedule[day]) } }));
  const setSelfTime = (day, field, value) =>
    setSelfForm((prev) => ({ ...prev, schedule: { ...prev.schedule, [day]: { ...prev.schedule[day], [field]: value } } }));

  const togglePhysAmenity = (item) =>
    setPhysForm((prev) => ({
      ...prev,
      amenities: prev.amenities.includes(item) ? prev.amenities.filter((a) => a !== item) : [...prev.amenities, item],
    }));

  const saveSelf = async () => {
    await updateListingInfo(listing.id, selfForm, { needsReaudit: false });
    showToast(`${listing.roomName}: updated. Live immediately.`);
  };

  const savePhys = async () => {
    await updateListingInfo(listing.id, physForm, { needsReaudit: true });
    showToast(`${listing.roomName}: saved. Since this affects what was physically verified, it's back in the audit queue and hidden from Browse until re-checked.`);
  };

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>{listing.roomName}</h2>
        <Badge label={badge.text} bg={badge.bg} fg={badge.fg} />
      </div>

      <h3 className="sc-form-subheading" style={{ marginTop: 20 }}>
        Details you can update anytime
      </h3>
      <p className="sc-form-hint">Price, schedule, and fees don't need a site visit to confirm — changes here go live immediately.</p>
      <div className="sc-form-grid">
        <Field label="Price per hour (SGD)">
          <input type="number" min={0} value={selfForm.pricePerHour} onChange={(e) => updateSelf("pricePerHour", e.target.value)} />
        </Field>
        <Field label="Minimum booking (hours)">
          <input type="number" min={2} value={selfForm.minBookingHours} onChange={(e) => updateSelf("minBookingHours", e.target.value)} />
        </Field>
      </div>
      <ScheduleGrid schedule={selfForm.schedule} onToggleDay={toggleSelfDay} onTimeChange={setSelfTime} />
      <div className="sc-form-grid">
        <Field label="Long-term booking discount?">
          <label className="sc-form-check">
            <input type="checkbox" checked={selfForm.longTermDiscount} onChange={(e) => updateSelf("longTermDiscount", e.target.checked)} />
            Yes, offer a discount
          </label>
        </Field>
        <Field label="Security deposit?">
          <label className="sc-form-check">
            <input type="checkbox" checked={selfForm.hasDeposit} onChange={(e) => updateSelf("hasDeposit", e.target.checked)} />
            Yes, a deposit applies
          </label>
          {selfForm.hasDeposit && (
            <input type="number" placeholder="Deposit amount (SGD)" value={selfForm.deposit} onChange={(e) => updateSelf("deposit", e.target.value)} />
          )}
        </Field>
      </div>
      <Field label="Additional fees (optional)">
        <input value={selfForm.additionalFees} onChange={(e) => updateSelf("additionalFees", e.target.value)} />
      </Field>
      <Field label="Photos (optional)">
        <MultiPhotoUploadField photos={selfForm.photos} onChange={(photos) => updateSelf("photos", photos)} />
      </Field>
      <button type="button" className="sc-form-btn" onClick={saveSelf}>
        Save these details
      </button>

      <h3 className="sc-form-subheading">Physical features (triggers a quick re-check)</h3>
      <p className="sc-form-hint">
        These are exactly what "Verified" confirms about the room. Changing them here — e.g. installing CCTV or
        upgrading a printer — puts this listing back in the audit queue and hides it from Browse until we've
        confirmed the change, usually from a short video rather than a full re-visit.
      </p>
      <div className="sc-form-grid">
        <Field label="Capacity (seats)">
          <input type="number" min={1} value={physForm.capacity} onChange={(e) => setPhysForm((p) => ({ ...p, capacity: e.target.value }))} />
        </Field>
        <Field label="Toilet access">
          <select value={physForm.toiletType} onChange={(e) => setPhysForm((p) => ({ ...p, toiletType: e.target.value }))}>
            <option value="">Select one</option>
            <option value="common_center">Common, within center</option>
            <option value="common_building">Shared building common toilet</option>
          </select>
        </Field>
      </div>
      <Field label="Amenities">
        <AmenityPicker amenities={physForm.amenities} onToggle={togglePhysAmenity} />
      </Field>
      <button type="button" className="sc-form-btn-ghost" onClick={savePhys}>
        Save & flag for re-check
      </button>
    </section>
  );
}

// ================= ADMIN =================
function Admin({ unlocked, pw, setPw, unlock, centers, listings, inquiries, centerById, setListingAudit, setCenterStanding, setInquiryStatus }) {
  if (!unlocked) {
    return (
      <div style={{ maxWidth: 320 }}>
        <h1 style={{ fontSize: 22, fontFamily: SERIF }}>Admin</h1>
        <Field label="Passcode">
          <input type="password" style={inputStyle} value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && unlock()} />
        </Field>
        <Button onClick={unlock}>Unlock</Button>
      </div>
    );
  }

  const pending = listings.filter((l) => l.auditStatus === "pending_review");
  const verified = listings.filter((l) => l.auditStatus === "verified");
  const flagged = listings.filter((l) => l.auditStatus === "flagged");
  const pendingInquiries = inquiries.filter((i) => i.status === "pending");

  return (
    <div>
      <h1 style={{ fontSize: 24, fontFamily: SERIF, fontWeight: 600 }}>Admin — audit &amp; standing</h1>

      <Section title={`Pending audit (${pending.length})`}>
        {pending.length === 0 && <Empty text="Nothing waiting on a site visit." />}
        {pending.map((l) => (
          <PendingAuditRow
            key={l.id}
            listing={l}
            center={centerById(l.centerId)}
            onVerify={(videoUrl, calendarUrl) => setListingAudit(l.id, "verified", videoUrl, calendarUrl)}
            onFlag={() => setListingAudit(l.id, "flagged")}
          />
        ))}
      </Section>

      <Section title={`Verified & live (${verified.length})`}>
        {verified.length === 0 && <Empty text="No live listings yet." />}
        {verified.map((l) => (
          <AdminListingRow key={l.id} listing={l} center={centerById(l.centerId)}>
            <Button variant="danger" onClick={() => setListingAudit(l.id, "flagged")}>
              Flag for re-audit
            </Button>
          </AdminListingRow>
        ))}
      </Section>

      {flagged.length > 0 && (
        <Section title={`Flagged (${flagged.length})`}>
          {flagged.map((l) => (
            <PendingAuditRow
              key={l.id}
              listing={l}
              center={centerById(l.centerId)}
              onVerify={(videoUrl, calendarUrl) => setListingAudit(l.id, "verified", videoUrl, calendarUrl)}
              onFlag={() => setListingAudit(l.id, "flagged")}
              reVerifyMode
            />
          ))}
        </Section>
      )}

      <Section title={`Pending inquiries (${pendingInquiries.length})`}>
        {pendingInquiries.length === 0 && <Empty text="No open inquiries." />}
        {pendingInquiries.map((i) => {
          const listing = listings.find((l) => l.id === i.listingId);
          return (
            <div key={i.id} style={{ border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 12, marginBottom: 8, fontSize: 13 }}>
              <div style={{ fontWeight: 700 }}>{i.tutorName}</div>
              <div style={{ color: COLORS.inkSoft }}>
                {listing?.roomName} · {i.tutorContact}
              </div>
              <div style={{ color: COLORS.inkSoft, marginTop: 2 }}>
                {i.slots ? slotSummary(i.slots) : `${i.date} ${i.start} · ${i.durationHours}h`}
              </div>
              {i.startDate && (
                <div style={{ color: COLORS.inkSoft, marginTop: 2 }}>
                  From {i.startDate} · {COMMITMENT_OPTIONS.find((o) => o.value === i.commitmentLength)?.label || i.commitmentLength}
                </div>
              )}
              {i.notes && <div style={{ color: COLORS.inkSoft, marginTop: 4 }}>"{i.notes}"</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <Button variant="accent" onClick={() => setInquiryStatus(i.id, "confirmed")}>
                  Confirmed
                </Button>
                <Button variant="ghost" onClick={() => setInquiryStatus(i.id, "declined")}>
                  Declined
                </Button>
              </div>
            </div>
          );
        })}
      </Section>

      <Section title={`Centers (${centers.length})`}>
        {centers.length === 0 && <Empty text="No centers registered yet." />}
        {centers.map((c) => {
          const badge = STANDING_LABEL[c.standing];
          return (
            <div key={c.id} style={{ border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 12, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{c.centerName}</div>
                <div style={{ color: COLORS.inkSoft }}>
                  {c.contactName} · {c.phone}
                </div>
                {c.strikes?.length > 0 && (
                  <div style={{ color: COLORS.danger, marginTop: 2 }}>
                    {c.strikes.length} strike{c.strikes.length > 1 ? "s" : ""} on record
                  </div>
                )}
                {c.marketingNotes && (
                  <div style={{ color: COLORS.inkSoft, marginTop: 4, maxWidth: 380, fontStyle: "italic" }}>"{c.marketingNotes}"</div>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Badge label={badge.text} bg={badge.bg} fg={badge.fg} />
                <select
                  style={{ ...inputStyle, width: 150 }}
                  value={c.standing}
                  onChange={(e) => setCenterStanding(c.id, e.target.value, e.target.value !== "active" ? `Standing changed to ${e.target.value}` : null)}
                >
                  <option value="active">Active</option>
                  <option value="warned">Warned</option>
                  <option value="suspended">Suspended</option>
                  <option value="banned">Banned</option>
                </select>
              </div>
            </div>
          );
        })}
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginTop: 26 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.inkSoft, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ text }) {
  return <div style={{ color: COLORS.inkSoft, fontSize: 13, padding: "10px 0" }}>{text}</div>;
}

function PendingAuditRow({ listing, center, onVerify, onFlag, reVerifyMode }) {
  const [videoUrl, setVideoUrl] = useState(listing.siteTourVideoUrl || "");
  const [calendarUrl, setCalendarUrl] = useState(listing.calendarBookingUrl || "");
  return (
    <div style={{ border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 12, marginBottom: 8, fontSize: 13 }}>
      <div style={{ fontWeight: 700 }}>{listing.roomName}</div>
      <div style={{ color: COLORS.inkSoft, marginBottom: 4 }}>
        {center?.centerName} · {center?.address} · up to {listing.capacity} pax · ${listing.pricePerHour}/hr · {formatMinBooking(listing)}h min
      </div>
      {listing.amenities?.length > 0 && <div style={{ color: COLORS.inkSoft, marginBottom: 4 }}>{listing.amenities.join(", ")}</div>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {typeof listing.readinessScoreAtSubmission === "number" && (
          <Badge label={`Readiness ${listing.readinessScoreAtSubmission}/100`} bg={COLORS.brassSoft} fg={COLORS.brass} />
        )}
        {reVerifyMode && <Badge label="Edited — needs re-check" bg={COLORS.dangerSoft} fg={COLORS.danger} />}
      </div>
      {listing.addressMatchWarning && (
        <div style={{ color: COLORS.danger, fontSize: 12.5, marginBottom: 8, fontStyle: "italic" }}>⚠ {listing.addressMatchWarning}</div>
      )}
      <Field label="Site tour video URL" hint="Record during the first inspection and paste the link here — required to mark verified.">
        <input style={inputStyle} placeholder="https://..." value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} />
      </Field>
      <Field
        label="Google Calendar booking link"
        hint="Set up as part of this visit — create the classroom's own booking calendar and paste its appointment link here. Optional if the calendar isn't ready yet."
      >
        <input style={inputStyle} placeholder="https://calendar.app.google/..." value={calendarUrl} onChange={(e) => setCalendarUrl(e.target.value)} />
      </Field>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="accent" disabled={!videoUrl.trim()} onClick={() => onVerify(videoUrl.trim(), calendarUrl.trim())}>
          Mark verified
        </Button>
        <Button variant="danger" onClick={onFlag}>
          Flag
        </Button>
      </div>
    </div>
  );
}

function AdminListingRow({ listing, center, children }) {
  return (
    <div style={{ border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 12, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, flexWrap: "wrap", gap: 8 }}>
      <div>
        <div style={{ fontWeight: 700 }}>{listing.roomName}</div>
        <div style={{ color: COLORS.inkSoft }}>
          {center?.centerName} · {center?.address} · up to {listing.capacity} pax · ${listing.pricePerHour}/hr
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>{children}</div>
    </div>
  );
}

// ---------- CSS for the intake / manage-listing forms ----------
function ListFormStyle() {
  return (
    <style>{`
      .sc-form-root {
        font-family: ${SANS};
        color: ${COLORS.ink};
      }
      .sc-form-header { margin-bottom: 32px; }
      .sc-form-header h1 {
        font-family: ${SERIF};
        font-size: 30px;
        font-weight: 600;
        margin: 0 0 8px;
        line-height: 1.15;
      }
      .sc-form-sub { color: ${COLORS.inkSoft}; font-size: 15px; max-width: 520px; margin: 0; }
      .sc-form-body { display: flex; gap: 32px; align-items: flex-start; }
      .sc-form-rail {
        flex: 0 0 180px;
        position: sticky;
        top: 90px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .sc-form-rail-step {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 0;
        font-size: 13px;
        color: ${COLORS.inkSoft};
      }
      .sc-form-rail-step.is-active { color: ${COLORS.ink}; font-weight: 600; }
      .sc-form-rail-dot {
        width: 22px; height: 22px;
        border-radius: 50%;
        border: 1px solid ${COLORS.line};
        display: flex; align-items: center; justify-content: center;
        font-size: 11px;
        flex-shrink: 0;
        background: ${COLORS.panelRaised};
      }
      .sc-form-rail-step.is-active .sc-form-rail-dot { border-color: ${COLORS.chalk}; color: ${COLORS.chalk}; }
      .sc-form-rail-step.is-done .sc-form-rail-dot { background: ${COLORS.chalk}; border-color: ${COLORS.chalk}; color: #fff; }
      .sc-form-panel {
        flex: 1;
        background: ${COLORS.panelRaised};
        border: 1px solid ${COLORS.line};
        border-radius: 4px;
        padding: 32px;
        min-width: 0;
      }
      .sc-form-panel h2 { font-family: ${SERIF}; font-size: 22px; margin: 0 0 20px; }
      .sc-form-subheading { font-family: ${SERIF}; font-size: 18px; margin: 28px 0 6px; }
      .sc-form-panel select {
        width: 100%;
        font-family: inherit;
        font-size: 14px;
        padding: 9px 11px;
        border: 1px solid ${COLORS.line};
        border-radius: 3px;
        background: #fff;
        color: ${COLORS.ink};
        box-sizing: border-box;
      }
      .sc-form-rail-score {
        margin-top: 20px;
        padding: 14px;
        border: 1px solid ${COLORS.line};
        border-radius: 4px;
        background: ${COLORS.panelRaised};
      }
      .sc-form-rail-score-num { font-family: ${SERIF}; font-size: 28px; color: ${COLORS.chalk}; line-height: 1; }
      .sc-form-rail-score-label { font-size: 11px; color: ${COLORS.inkSoft}; margin: 4px 0 8px; }
      .sc-form-rail-score-bar { height: 5px; background: ${COLORS.line}; border-radius: 3px; overflow: hidden; }
      .sc-form-rail-score-fill { height: 100%; background: ${COLORS.chalk}; }
      .sc-form-rail-score-hint { font-size: 10.5px; color: ${COLORS.inkSoft}; margin-top: 6px; }
      .sc-form-report { border: 1px solid ${COLORS.line}; border-radius: 4px; background: #fff; padding: 24px; margin-bottom: 28px; }
      .sc-form-report-headline { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
      .sc-form-report-score { font-family: ${SERIF}; font-size: 48px; color: ${COLORS.chalk}; line-height: 1; }
      .sc-form-report-tier { font-weight: 600; font-size: 16px; }
      .sc-form-report-tier-sub { font-size: 12.5px; color: ${COLORS.inkSoft}; }
      .sc-form-report-row { margin-bottom: 12px; }
      .sc-form-report-row-top { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; }
      .sc-form-report-track { height: 7px; background: ${COLORS.bg}; border-radius: 4px; overflow: hidden; }
      .sc-form-report-fill { height: 100%; background: ${COLORS.brass}; }
      .sc-form-report-tips { margin-top: 20px; padding-top: 16px; border-top: 1px solid ${COLORS.line}; }
      .sc-form-report-tips-label { font-weight: 600; font-size: 13px; margin-bottom: 10px; }
      .sc-form-report-tips ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px; }
      .sc-form-report-tips li { font-size: 13.5px; color: ${COLORS.inkSoft}; line-height: 1.5; }
      .sc-form-success-score { margin-top: 16px; font-size: 14px; color: ${COLORS.ink}; }
      .sc-form-hint { color: ${COLORS.inkSoft}; font-size: 13px; margin: -12px 0 20px; }
      .sc-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; margin-bottom: 4px; }
      .sc-form-note { font-size: 12.5px; color: ${COLORS.inkSoft}; margin-top: 6px; }
      .sc-form-remove { border: none; background: none; color: ${COLORS.danger}; font-size: 13px; cursor: pointer; padding: 4px 0; margin-top: 8px; }
      .sc-form-add {
        width: 100%;
        padding: 12px;
        border: 1px dashed ${COLORS.line};
        border-radius: 4px;
        background: none;
        color: ${COLORS.chalk};
        font-weight: 600;
        font-size: 14px;
        cursor: pointer;
      }
      .sc-form-review-block { border-bottom: 1px solid ${COLORS.line}; padding: 14px 0; }
      .sc-form-review-block h3 { margin: 0 0 6px; font-size: 15px; font-family: ${SERIF}; }
      .sc-form-review-line { margin: 0 0 4px; font-size: 13.5px; color: ${COLORS.inkSoft}; }
      .sc-form-actions { display: flex; justify-content: space-between; margin-top: 24px; border-top: 1px solid ${COLORS.line}; padding-top: 20px; }
      .sc-form-btn {
        background: ${COLORS.chalk};
        color: #fff;
        border: none;
        padding: 11px 22px;
        border-radius: 3px;
        font-weight: 600;
        font-size: 14px;
        cursor: pointer;
        margin: 12px 0 0 auto;
        display: block;
        font-family: ${SANS};
      }
      .sc-form-actions .sc-form-btn { margin: 0 0 0 auto; }
      .sc-form-btn-ghost {
        background: none;
        border: 1px solid ${COLORS.line};
        padding: 11px 22px;
        border-radius: 3px;
        font-size: 14px;
        cursor: pointer;
        color: ${COLORS.inkSoft};
        font-family: ${SANS};
        margin-top: 12px;
      }
      .sc-form-success { text-align: center; padding: 60px 20px; }
      .sc-form-success-mark {
        width: 48px; height: 48px;
        border-radius: 50%;
        background: ${COLORS.chalk};
        color: #fff;
        display: flex; align-items: center; justify-content: center;
        font-size: 22px;
        margin: 0 auto 16px;
      }
      .sc-form-success h2 { font-family: ${SERIF}; }
      .sc-form-success p { color: ${COLORS.inkSoft}; max-width: 440px; margin: 0 auto; }
      .sc-form-card { border: 1px solid ${COLORS.line}; border-radius: 4px; margin-bottom: 16px; overflow: hidden; background: #fff; }
      .sc-form-card-head {
        width: 100%;
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 16px;
        background: ${COLORS.bg};
        border: none;
        font-family: inherit;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        color: ${COLORS.ink};
        text-align: left;
      }
      .sc-form-chevron { color: ${COLORS.inkSoft}; font-size: 16px; }
      .sc-form-card-body { padding: 20px 16px; }
      .sc-form-amenity-groups { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      .sc-form-amenity-group-label { font-size: 12px; font-weight: 600; color: ${COLORS.brass}; margin-bottom: 6px; }
      .sc-form-amenity-items { display: flex; flex-direction: column; gap: 0; }
      .sc-form-schedule {
        display: flex;
        flex-direction: column;
        gap: 6px;
        border: 1px solid ${COLORS.line};
        border-radius: 4px;
        padding: 10px 12px;
        background: #fff;
      }
      .sc-form-schedule-row {
        display: grid;
        grid-template-columns: 84px 1fr auto 1fr;
        align-items: center;
        gap: 8px;
        padding: 4px 0;
        opacity: 0.55;
      }
      .sc-form-schedule-row.is-on { opacity: 1; }
      .sc-form-schedule-daylabel {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13.5px;
        font-weight: 600;
        color: ${COLORS.ink};
        cursor: pointer;
      }
      .sc-form-schedule-daylabel input[type="checkbox"] {
        width: 17px;
        height: 17px;
        margin: 0;
        flex-shrink: 0;
        accent-color: ${COLORS.chalk};
        cursor: pointer;
      }
      .sc-form-schedule-sep { font-size: 12px; color: ${COLORS.inkSoft}; text-align: center; }
      .sc-form-schedule input[type="time"] {
        width: 100%;
        font-family: inherit;
        font-size: 13.5px;
        padding: 7px 9px;
        border: 1px solid ${COLORS.line};
        border-radius: 3px;
        background: #fff;
        color: ${COLORS.ink};
        box-sizing: border-box;
      }
      .sc-form-schedule input[type="time"]:disabled { background: ${COLORS.bg}; color: ${COLORS.inkSoft}; }
      .sc-form-panel input:not([type="checkbox"]), .sc-form-panel textarea {
        font-family: inherit;
        font-size: 14px;
        padding: 9px 11px;
        border: 1px solid ${COLORS.line};
        border-radius: 3px;
        background: #fff;
        color: ${COLORS.ink};
        box-sizing: border-box;
        width: 100%;
      }
      .sc-form-panel input:disabled, .sc-form-panel textarea:disabled, .sc-form-panel select:disabled {
        background: ${COLORS.bg};
        color: ${COLORS.inkSoft};
      }
      .sc-form-panel input:focus, .sc-form-panel textarea:focus, .sc-form-panel select:focus {
        outline: 2px solid ${COLORS.chalk};
        outline-offset: 1px;
      }
      .sc-form-check {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13.5px;
        font-weight: 400;
        color: ${COLORS.ink};
        margin-bottom: 10px;
        cursor: pointer;
      }
      .sc-form-check input[type="checkbox"] {
        width: 17px;
        height: 17px;
        margin: 0;
        flex-shrink: 0;
        accent-color: ${COLORS.chalk};
        cursor: pointer;
      }
      .sc-form-amenity-items .sc-form-check:last-child { margin-bottom: 0; }
      .sc-form-photo { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
      .sc-form-photo-grid { display: flex; flex-wrap: wrap; gap: 10px; }
      .sc-form-photo-thumb { position: relative; width: 110px; height: 88px; }
      .sc-form-photo-thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 4px;
        border: 1px solid ${COLORS.line};
      }
      .sc-form-photo-remove {
        position: absolute;
        top: -6px;
        right: -6px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        border: none;
        background: ${COLORS.danger};
        color: #fff;
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .sc-form-photo-upload {
        display: inline-block;
        padding: 9px 16px;
        border: 1px solid ${COLORS.line};
        border-radius: 3px;
        background: #fff;
        color: ${COLORS.chalk};
        font-weight: 600;
        font-size: 13.5px;
        cursor: pointer;
      }
      @media (max-width: 680px) {
        .sc-form-body { flex-direction: column; }
        .sc-form-rail { flex-direction: row; overflow-x: auto; position: static; width: 100%; }
        .sc-form-grid, .sc-form-amenity-groups { grid-template-columns: 1fr; }
        .sc-form-schedule-row { grid-template-columns: 70px 1fr auto 1fr; }
        .sc-form-panel { padding: 20px; }
      }
    `}</style>
  );
}
