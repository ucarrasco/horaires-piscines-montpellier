import { useEffect, useState } from "react";
import {
  DAY_LABELS,
  PERIOD_LABELS,
  type HorairesData,
  type PeriodSpan,
  type PoolResult,
  type ResolvedDay,
} from "./types.ts";

const DATA_URL = `${import.meta.env.BASE_URL}data/horaires.json`;

export default function App() {
  const [data, setData] = useState<HorairesData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(DATA_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<HorairesData>;
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="page">
      <header>
        <h1>🏊 Piscines de Montpellier</h1>
        <p className="subtitle">
          Horaires réels des 2 prochaines semaines, mis à jour chaque jour.
        </p>
      </header>

      {error && <p className="error">Impossible de charger les horaires : {error}</p>}
      {!error && !data && <p className="muted">Chargement…</p>}

      {data && (
        <>
          <PeriodsBanner periods={data.periodsInWindow} />
          <ClosuresBanner pools={data.pools} />
          {data.pools.map((pool) => (
            <PoolCard key={pool.id} pool={pool} today={data.generatedAt} />
          ))}
          <footer>
            Fenêtre du {fmtDate(data.window.start)} au {fmtDate(data.window.end)} —
            dernière mise à jour : {new Date(data.generatedAt).toLocaleString("fr-FR")}
          </footer>
        </>
      )}
    </div>
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
    p.events
      .filter((e) => e.closed)
      .map((e) => ({ pool: p.name, e })),
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
  const todayDate = today.slice(0, 10);
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
          {pool.resolved.map((d) => (
            <DayRow key={d.date} day={d} isToday={d.date === todayDate} />
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
            <span className="slot" key={i}>
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
