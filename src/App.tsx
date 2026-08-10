import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  DAY_LABELS,
  PERIOD_LABELS,
  type SchedulesData,
  type PeriodSpan,
  type PoolResult,
  type ResolvedDay,
} from "./types.ts";

const DATA_URL = `${import.meta.env.BASE_URL}data/schedules.json`;

export default function App() {
  const [data, setData] = useState<SchedulesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPools, setShowPools] = useState(false);

  useEffect(() => {
    fetch(DATA_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<SchedulesData>;
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="page">
      <header>
        <h1>🏊 Piscines de Montpellier</h1>
        <p className="subtitle">
          Horaires réels des prochains jours, mis à jour depuis les pages officielles.
          {data && <FreshnessBadge generatedAt={data.generatedAt} />}
        </p>
      </header>

      {error && (
        <p className="error">Impossible de charger les horaires : {error}</p>
      )}
      {!error && !data && <p className="muted">Chargement…</p>}

      {data && (
        <>
          <DayAgenda data={data} />

          <button
            type="button"
            className="disclosure"
            aria-expanded={showPools}
            onClick={() => setShowPools((v) => !v)}
          >
            <span className="disclosure-caret" aria-hidden="true">
              ▸
            </span>
            Détails par piscine
          </button>

          {showPools &&
            data.pools.map((pool) => (
              <PoolCard key={pool.id} pool={pool} today={anchorDate(data)} />
            ))}
        </>
      )}
    </div>
  );
}

const FRESH_MAX_HOURS = 24;
const STALE_MAX_HOURS = 5 * 24;

/**
 * How old the data is: a colour level based on elapsed hours, and a delay
 * expressed in calendar days in Paris (so a 20:00 → 08:00 gap reads "hier").
 */
function freshness(generatedAt: string) {
  const hours = (Date.now() - new Date(generatedAt).getTime()) / 3_600_000;
  const level =
    hours < FRESH_MAX_HOURS
      ? "fresh"
      : hours < STALE_MAX_HOURS
        ? "stale"
        : "old";

  const days = Math.round(
    (Date.parse(`${todayInParis()}T12:00:00Z`) -
      Date.parse(`${parisDateOf(new Date(generatedAt))}T12:00:00Z`)) /
      86_400_000,
  );
  const delay =
    days <= 0 ? "aujourd'hui" : days === 1 ? "hier" : `il y a ${days} jours`;

  return { level, delay };
}

function FreshnessBadge({ generatedAt }: { generatedAt: string }) {
  const { level, delay } = freshness(generatedAt);
  return (
    <span
      className={`freshness freshness-${level}`}
      title={`Dernier relevé des horaires : ${new Date(generatedAt).toLocaleString("fr-FR")}`}
    >
      Mis à jour : {delay}
    </span>
  );
}

const HOUR_HEIGHT = 52; // px
const BODY_PADDING = 30; // px of breathing room above/below the grid
const DEFAULT_RANGE = [8, 22];

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m ?? 0);
}

function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(":");
  return `${h.padStart(2, "0")}:${(m ?? "00").padStart(2, "0")}`;
}

function shortPoolName(name: string): string {
  return name.replace(/^(Piscine|Centre aquatique)\s+/i, "");
}

function nowMinutesInParis(): number {
  return toMinutes(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date()),
  );
}

function useNowMinutes(): number {
  const [now, setNow] = useState(nowMinutesInParis);
  useEffect(() => {
    const id = setInterval(() => setNow(nowMinutesInParis()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Calendar date "YYYY-MM-DD" of an instant, as seen in Paris. */
function parisDateOf(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function todayInParis(): string {
  return parisDateOf(new Date());
}

function fmtLongDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** "Aujourd'hui" / "Demain", or the full date for any other day. */
function dayLabel(iso: string): string {
  const today = todayInParis();
  if (iso === today) return "Aujourd'hui";

  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (iso === tomorrow.toISOString().slice(0, 10)) return "Demain";

  return fmtLongDate(iso);
}

/**
 * The date the site anchors "today" to: the real current date, or the
 * generation date when the data is too old to cover today.
 */
function anchorDate(data: SchedulesData): string {
  const today = todayInParis();
  return data.window.dates.includes(today) ? today : data.generatedAt.slice(0, 10);
}

const POOL_ORDER_KEY = "poolPositions";

const DEFAULT_POOL_ORDER = [
  "olympique-antigone",
  "neptune",
  "suzanne-berlioux",
  "pitot",
  "marcel-spilliaert",
  "jean-vives",
  "jean-taris",
  "alfred-nakache",
  "francoise-et-yves-jarrousse",
  "christine-caron",
  "amphitrite",
  "poseidon",
  "heracles",
  "les-nereides",
  "alex-jany",
];

function loadPoolOrder(): string[] {
  try {
    const stored = localStorage.getItem(POOL_ORDER_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
      return parsed;
    }
  } catch {
    // localStorage unavailable or corrupted JSON: fall back to the default order
  }
  return DEFAULT_POOL_ORDER;
}

/**
 * Display order of the pools, persisted in localStorage.
 * The stored order is reconciled with the pools actually present in the data:
 * unknown ids are dropped, new pools are appended at the end.
 */
function usePoolOrder(
  poolIds: string[],
): [string[], (from: number, to: number) => void] {
  const [order, setOrder] = useState(loadPoolOrder);
  const key = poolIds.join(",");

  const ordered = useMemo(() => {
    const known = order.filter((id) => poolIds.includes(id));
    return [...known, ...poolIds.filter((id) => !known.includes(id))];
  }, [order, key]);

  useEffect(() => {
    try {
      localStorage.setItem(POOL_ORDER_KEY, JSON.stringify(ordered));
    } catch {
      // storage unavailable (private mode, quota): the order stays in memory only
    }
  }, [ordered]);

  const move = (from: number, to: number) => {
    const next = [...ordered];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id);
    setOrder(next);
  };

  return [ordered, move];
}

/**
 * Column reordering through native drag & drop.
 * `dropIndex` is an insertion position (0..n), not a column index.
 */
function useColumnDrag(
  poolIds: string[],
  onReorder: (from: number, to: number) => void,
) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const reset = () => {
    setDragIndex(null);
    setDropIndex(null);
  };

  return {
    dragIndex,
    dropIndex,
    handlers: (index: number) => ({
      draggable: true,
      onDragStart: (e: DragEvent) => {
        setDragIndex(index);
        setDropIndex(index);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", poolIds[index]);
      },
      onDragOver: (e: DragEvent) => {
        if (dragIndex === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const { left, width } = e.currentTarget.getBoundingClientRect();
        setDropIndex(e.clientX < left + width / 2 ? index : index + 1);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        if (dragIndex === null || dropIndex === null) return reset();
        const newIndex = dropIndex > dragIndex ? dropIndex - 1 : dropIndex;
        if (newIndex !== dragIndex) onReorder(dragIndex, newIndex);
        reset();
      },
      onDragEnd: reset,
    }),
  };
}

function DayAgenda({ data }: { data: SchedulesData }) {
  const nowMinutes = useNowMinutes();
  const [date, setDate] = useState(() => anchorDate(data));
  const isToday = date === todayInParis();

  // Navigation is bounded by the days the scraper actually resolved.
  const dates = data.window.dates;
  const index = dates.indexOf(date);
  const step = (delta: number) => setDate(dates[index + delta]);

  const [order, movePool] = usePoolOrder(data.pools.map((p) => p.id));

  const columns = order.flatMap((id) => {
    const pool = data.pools.find((p) => p.id === id);
    if (!pool) return [];
    return [{ pool, day: pool.resolved.find((d) => d.date === date) ?? null }];
  });

  const allSlots = columns.flatMap(({ day }) =>
    day && !day.closed ? day.slots : [],
  );
  const [startHour, endHour] = allSlots.length
    ? [
        Math.floor(Math.min(...allSlots.map((s) => toMinutes(s.start))) / 60),
        Math.ceil(Math.max(...allSlots.map((s) => toMinutes(s.end))) / 60),
      ]
    : DEFAULT_RANGE;

  const hours = Array.from(
    { length: endHour - startHour + 1 },
    (_, i) => startHour + i,
  );
  const bodyHeight = (endHour - startHour) * HOUR_HEIGHT + 2 * BODY_PADDING;
  const offsetOf = (minutes: number) =>
    BODY_PADDING + ((minutes - startHour * 60) / 60) * HOUR_HEIGHT;
  const offset = (hhmm: string) => offsetOf(toMinutes(hhmm));

  const showNow =
    isToday && nowMinutes >= startHour * 60 && nowMinutes <= endHour * 60;

  const drag = useColumnDrag(
    columns.map(({ pool }) => pool.id),
    movePool,
  );

  return (
    <section className="agenda">
      <div className="agenda-header">
        <h2>
          {dayLabel(date)}
          {dayLabel(date) !== fmtLongDate(date) && (
            <span className="agenda-date">{fmtLongDate(date)}</span>
          )}
        </h2>
        <div className="agenda-nav">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={index <= 0}
            aria-label="Jour précédent"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={index < 0 || index >= dates.length - 1}
            aria-label="Jour suivant"
          >
            ›
          </button>
        </div>
      </div>

      <div className="agenda-scroll">
        <div
          className="agenda-grid"
          style={{
            gridTemplateColumns: `var(--gutter) repeat(${columns.length}, var(--col))`,
            gridTemplateRows: `auto ${bodyHeight}px`,
            ["--gutter" as string]: "3.5rem",
            ["--col" as string]: "6.5rem",
          }}
        >
          <div className="agenda-corner" style={{ gridArea: "1 / 1" }} />
          {columns.map(({ pool, day }, index) => {
            const info = day && !day.closed ? day.events.join(" · ") : null;
            const classes = ["agenda-head"];
            if (info) classes.push("has-info");
            if (drag.dragIndex === index) classes.push("dragging");
            return (
              <div
                className={classes.join(" ")}
                key={pool.id}
                style={{ gridArea: `1 / ${index + 2}` }}
                {...drag.handlers(index)}
              >
                <span className="agenda-grip" aria-hidden="true">
                  ⠿
                </span>
                <span className="agenda-pool" title={pool.name}>
                  {shortPoolName(pool.name)}
                </span>
                {info && (
                  <span className="agenda-info" title={info}>
                    ⓘ
                  </span>
                )}
              </div>
            );
          })}

          <div className="agenda-gutter" style={{ gridArea: "2 / 1" }}>
            {hours.map((h) => (
              <span
                className="agenda-tick"
                key={h}
                style={{ top: offset(`${h}:00`) }}
              >
                {String(h).padStart(2, "0")}h
              </span>
            ))}
          </div>

          {columns.map(({ pool, day }, index) => (
            <div
              className="agenda-col"
              style={{ gridArea: `2 / ${index + 2}` }}
              key={pool.id}
            >
              {hours.map((h) => (
                <div
                  className="agenda-line"
                  key={h}
                  style={{ top: offset(`${h}:00`) }}
                />
              ))}
              {(!day || day.closed || day.slots.length === 0) && (
                <span className="agenda-empty">
                  {pool.status === "error" ? "Horaires indispo" : "Fermé"}
                </span>
              )}
              {day &&
                !day.closed &&
                day.slots.map((s, i) => (
                  <div
                    className="agenda-slot"
                    key={i}
                    style={{
                      top: offset(s.start),
                      height: Math.max(offset(s.end) - offset(s.start), 20),
                    }}
                  >
                    <span className="agenda-slot-time">
                      {fmtTime(s.start)} – {fmtTime(s.end)}
                    </span>
                  </div>
                ))}
            </div>
          ))}

          {drag.dropIndex !== null && (
            <div className="agenda-drop-layer">
              <div
                className="agenda-drop"
                style={{
                  left: `calc(var(--gutter) + ${drag.dropIndex} * var(--col))`,
                }}
              />
            </div>
          )}

          {showNow && (
            <div className="agenda-now-layer">
              <div className="agenda-now" style={{ top: offsetOf(nowMinutes) }}>
                <span className="agenda-now-time">
                  {String(Math.floor(nowMinutes / 60)).padStart(2, "0")}:
                  {String(nowMinutes % 60).padStart(2, "0")}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function PeriodsBanner({ periods }: { periods: PeriodSpan[] }) {
  if (periods.length === 0) return null;
  return (
    <div className="periods">
      <strong>📅 Périodes sur la quinzaine</strong>
      <ul>
        {periods.map((p, i) => (
          <li key={i}>
            <span className={`period-tag period-${p.period}`}>
              {p.label ?? PERIOD_LABELS[p.period]}
            </span>{" "}
            du {fmtDate(p.start)} au {fmtDate(p.end)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClosuresBanner({ pools }: { pools: PoolResult[] }) {
  const items = pools.flatMap((p) =>
    p.events.filter((e) => e.closed).map((e) => ({ pool: p.name, e })),
  );
  if (items.length === 0) return null;
  return (
    <div className="closures">
      <strong>⚠️ Fermetures / événements</strong>
      <ul>
        {items.map(({ pool, e }, i) => (
          <li key={i}>
            <span className="closure-pool">{pool}</span> — {e.description} (
            {fmtDate(e.start)}
            {e.end && e.end !== e.start ? ` → ${fmtDate(e.end)}` : ""})
          </li>
        ))}
      </ul>
    </div>
  );
}

function PoolCard({ pool, today }: { pool: PoolResult; today: string }) {
  const upcoming = pool.resolved.filter((d) => d.date >= today);
  return (
    <section className="pool-card">
      <h2>
        {pool.url ? (
          <a href={pool.url} target="_blank" rel="noreferrer">
            {pool.name}
          </a>
        ) : (
          pool.name
        )}
        {pool.status === "error" && (
          <span className="badge-error" title={pool.error}>
            indispo
          </span>
        )}
      </h2>
      {pool.status === "error" ? (
        <p className="muted">Horaires indisponibles ({pool.error}).</p>
      ) : (
        <ul className="days">
          {upcoming.map((d) => (
            <DayRow key={d.date} day={d} isToday={d.date === today} />
          ))}
        </ul>
      )}
      {pool.notes && <p className="notes">{pool.notes}</p>}
    </section>
  );
}

function DayRow({ day, isToday }: { day: ResolvedDay; isToday: boolean }) {
  return (
    <li className={isToday ? "day today" : "day"}>
      <span className="day-date">
        {DAY_LABELS[day.day]} {fmtDate(day.date)}
      </span>
      <span className="day-slots">
        {day.closed ? (
          <span className="closed">
            Fermé{day.events.length > 0 ? ` — ${day.events.join(", ")}` : ""}
          </span>
        ) : day.slots.length === 0 ? (
          <span className="closed">Fermé</span>
        ) : (
          day.slots.map((s, i) => (
            <span
              className={day.exceptional ? "slot exceptional" : "slot"}
              key={i}
            >
              <span className="time">
                {s.start}–{s.end}
              </span>
              {s.label && <span className="label">{s.label}</span>}
            </span>
          ))
        )}
        {!day.closed && day.events.length > 0 && (
          <span className="day-event">{day.events.join(", ")}</span>
        )}
      </span>
      <span className={`period-tag period-${day.period}`}>
        {PERIOD_LABELS[day.period]}
      </span>
    </li>
  );
}

function fmtDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
  });
}
