import { useEffect, useState } from "react";
import {
  DAY_KEYS,
  DAY_LABELS,
  type HorairesData,
  type PoolResult,
  type Slot,
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
        <p className="subtitle">Horaires unifiés, mis à jour chaque jour.</p>
      </header>

      {error && <p className="error">Impossible de charger les horaires : {error}</p>}
      {!error && !data && <p className="muted">Chargement…</p>}

      {data && (
        <>
          <ClosuresBanner pools={data.pools} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="pool-col">Piscine</th>
                  {DAY_KEYS.map((d) => (
                    <th key={d}>{DAY_LABELS[d]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.pools.map((pool) => (
                  <PoolRow key={pool.id} pool={pool} />
                ))}
              </tbody>
            </table>
          </div>
          <footer>
            Dernière mise à jour :{" "}
            {new Date(data.generatedAt).toLocaleString("fr-FR")}
          </footer>
        </>
      )}
    </div>
  );
}

function ClosuresBanner({ pools }: { pools: PoolResult[] }) {
  const withClosures = pools.filter((p) => p.closures.length > 0);
  if (withClosures.length === 0) return null;
  return (
    <div className="closures">
      <strong>⚠️ Fermetures / infos exceptionnelles</strong>
      <ul>
        {withClosures.map((p) =>
          p.closures.map((c, i) => (
            <li key={`${p.id}-${i}`}>
              <span className="closure-pool">{p.name}</span> — {c}
            </li>
          )),
        )}
      </ul>
    </div>
  );
}

function PoolRow({ pool }: { pool: PoolResult }) {
  return (
    <tr>
      <th scope="row" className="pool-col">
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
      </th>
      {DAY_KEYS.map((d) => (
        <td key={d}>
          <DayCell slots={pool.days[d]} error={pool.status === "error"} />
        </td>
      ))}
    </tr>
  );
}

function DayCell({ slots, error }: { slots: Slot[]; error: boolean }) {
  if (error) return <span className="muted">—</span>;
  if (!slots || slots.length === 0)
    return <span className="closed">Fermé</span>;
  return (
    <ul className="slots">
      {slots.map((s, i) => (
        <li key={i}>
          <span className="time">
            {s.start}–{s.end}
          </span>
          {s.label && <span className="label">{s.label}</span>}
        </li>
      ))}
    </ul>
  );
}
