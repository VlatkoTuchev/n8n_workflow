import { query } from '../config/db';

function parseStart(row: any) {
  const val = (k: string) => (k && row[k] != null ? String(row[k]) : null);
  const datePart = val('event_date') || val('start_date') || val('date');
  const timePart = val('start_time') || val('time');
  const directTs = val('start_at') || val('starts_at') || val('start_datetime') || val('event_start') || val('datetime') || val('scheduled_at');
  let start: Date | null = null;
  if (directTs) {
    const d = new Date(directTs);
    if (!isNaN(d as any)) start = d;
  } else if (datePart && timePart) {
    const d = new Date(`${datePart} ${timePart}`);
    if (!isNaN(d as any)) start = d;
  } else if (datePart) {
    const d = new Date(`${datePart}T00:00:00`);
    if (!isNaN(d as any)) start = d;
  }
  return start;
}

export async function listCourses() {
  const colsRes = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='events_mysql_mirror'`,
  );
  const cols = new Set((colsRes.rows as any).map((r: any) => r.column_name));
  if (cols.size === 0) return [] as Array<any>;
  const selectCols = ['id'];
  const titleCol = cols.has('title') ? 'title' : cols.has('name') ? 'name' : null;
  if (titleCol) selectCols.push(titleCol);
  const maybeCols = ['start_at','starts_at','start_datetime','event_start','datetime','scheduled_at','event_date','start_date','date','start_time','time'];
  const present = maybeCols.filter((c) => cols.has(c));
  selectCols.push(...present);
  const sql = `SELECT ${selectCols.join(', ')} FROM events_mysql_mirror`;
  const ev = await query(sql);
  const now = new Date();
  const items = (ev.rows as any).map((row: any) => {
    const title = titleCol ? row[titleCol] : row.title || row.name || `Course ${row.id || ''}`;
    const start = parseStart(row);
    const status = start ? (start.getTime() > now.getTime() ? 'upcoming' : (start.toDateString() === now.toDateString() ? 'today' : 'past')) : 'unknown';
    return { id: row.id || null, title, start, status };
  });
  items.sort((a: any, b: any) => {
    const rank = (s: string) => (s === 'upcoming' ? 0 : s === 'today' ? 1 : s === 'past' ? 2 : 3);
    const ra = rank(a.status), rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    const ta = a.start ? a.start.getTime() : 0;
    const tb = b.start ? b.start.getTime() : 0;
    return ra === 2 ? tb - ta : ta - tb;
  });
  return items;
}

export async function recommendCourses(limit = 3, daysAhead = 60) {
  const items = await listCourses();
  const now = new Date();
  const futureLimit = new Date(now.getTime() + daysAhead * 86400000);
  return items
    .filter((x: any) => x.start && x.start > now && x.start <= futureLimit)
    .slice(0, Math.min(10, Math.max(1, limit)))
    .map((x: any) => ({ id: x.id, title: x.title, start_iso: x.start.toISOString() }));
}


