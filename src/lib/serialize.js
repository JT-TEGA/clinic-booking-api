function booking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function slot(row) {
  return {
    id: row.id,
    provider: row.provider,
    start: row.start,
    end: row.end,
    available: row.available,
  };
}

module.exports = { booking, slot };
