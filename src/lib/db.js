import { supabase } from "./supabaseClient";

// Each table stores its record's full shape as a jsonb `data` column,
// mirroring exactly what used to live in window.storage's JSON blobs.
// `id`, and for listings/inquiries a foreign key column, are pulled out
// as real columns so Postgres can enforce referential integrity (e.g.
// deleting a center cascades its listings) — everything else stays as
// flexible jsonb, since the app's data shape is still evolving and a
// fully normalized schema isn't worth the migration overhead yet.

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function unwrap(rows) {
  return rows.map((row) => ({ id: row.id, ...row.data }));
}

// ---------- Centers ----------
export async function fetchCenters() {
  const { data, error } = await supabase.from("centers").select("id, data").order("created_at", { ascending: true });
  if (error) throw error;
  return unwrap(data);
}

export async function insertCenter(center) {
  const id = uid();
  const record = { id, standing: "active", strikes: [], createdAt: Date.now(), ...center };
  const { error } = await supabase.from("centers").insert({ id, data: record, created_at: record.createdAt });
  if (error) throw error;
  return record;
}

export async function patchCenter(id, patch) {
  const { data: row, error: selErr } = await supabase.from("centers").select("data").eq("id", id).single();
  if (selErr) throw selErr;
  const merged = { ...row.data, ...patch };
  const { error } = await supabase.from("centers").update({ data: merged }).eq("id", id);
  if (error) throw error;
  return merged;
}

// ---------- Listings ----------
export async function fetchListings() {
  const { data, error } = await supabase.from("listings").select("id, data").order("created_at", { ascending: true });
  if (error) throw error;
  return unwrap(data);
}

export async function insertListing(listing) {
  const id = uid();
  const record = { id, auditStatus: "pending_review", lastAudited: null, createdAt: Date.now(), ...listing };
  const { error } = await supabase
    .from("listings")
    .insert({ id, center_id: listing.centerId, data: record, created_at: record.createdAt });
  if (error) throw error;
  return record;
}

export async function patchListing(id, patch) {
  const { data: row, error: selErr } = await supabase.from("listings").select("data").eq("id", id).single();
  if (selErr) throw selErr;
  const merged = { ...row.data, ...patch };
  const { error } = await supabase.from("listings").update({ data: merged }).eq("id", id);
  if (error) throw error;
  return merged;
}

// ---------- Inquiries ----------
export async function fetchInquiries() {
  const { data, error } = await supabase.from("inquiries").select("id, data").order("created_at", { ascending: true });
  if (error) throw error;
  return unwrap(data);
}

export async function insertInquiry(inquiry) {
  const id = uid();
  const record = { id, status: "pending", createdAt: Date.now(), ...inquiry };
  const { error } = await supabase
    .from("inquiries")
    .insert({ id, listing_id: inquiry.listingId, data: record, created_at: record.createdAt });
  if (error) throw error;
  return record;
}

export async function patchInquiry(id, patch) {
  const { data: row, error: selErr } = await supabase.from("inquiries").select("data").eq("id", id).single();
  if (selErr) throw selErr;
  const merged = { ...row.data, ...patch };
  const { error } = await supabase.from("inquiries").update({ data: merged }).eq("id", id);
  if (error) throw error;
  return merged;
}

// ---------- Classroom photos (Supabase Storage) ----------
// Real files in a public bucket, replacing the earlier stopgap of
// embedding a compressed image directly inside each listing's row — this
// is the version that actually supports more than one photo per classroom
// without bloating the database.
const PHOTOS_BUCKET = "classroom-photos";

export async function uploadClassroomPhoto(blob) {
  const path = `${uid()}.jpg`;
  const { error } = await supabase.storage.from(PHOTOS_BUCKET).upload(path, blob, {
    contentType: "image/jpeg",
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export async function deleteClassroomPhoto(publicUrl) {
  // Extract the storage path from the public URL rather than assuming a
  // fixed prefix, so this keeps working even if the project's URL changes.
  const marker = `/object/public/${PHOTOS_BUCKET}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return; // not a URL from this bucket — nothing to delete
  const path = publicUrl.slice(idx + marker.length);
  const { error } = await supabase.storage.from(PHOTOS_BUCKET).remove([path]);
  if (error) throw error;
}
