"use client";

import { Header } from "./Header";
import { IncidentFeed } from "./IncidentFeed";
import { SetupChecklist } from "./SetupChecklist";
import { StreamStats, StreamView } from "./StreamView";
import { useLive } from "./useLive";

export function Console() {
  const { status, statusError, incidents, connection, freshIds, upsert } = useLive();
  const monitoring = status?.worker.state === "running" && Boolean(status.zone);

  return (
    <>
      <Header status={status} statusError={statusError} />
      {statusError && (
        <p className="banner banner-down" role="alert">
          The console can&apos;t load its data: {statusError}. Check that Postgres is running and DATABASE_URL is set.
        </p>
      )}
      {connection === "reconnecting" && !statusError && (
        <p className="banner">Live updates paused. Reconnecting; new incidents will appear when it&apos;s back.</p>
      )}
      <main className="console">
        <div className="col-video">
          <SetupChecklist status={status} />
          <StreamView url={status ? "/api/stream" : undefined} worker={status?.worker} />
          <StreamStats worker={status?.worker} />
        </div>
        <IncidentFeed
          incidents={incidents}
          counts={status?.counts}
          freshIds={freshIds}
          roboflowConfigured={status?.roboflowConfigured ?? false}
          projectUrl={status?.roboflowProjectUrl ?? null}
          monitoring={monitoring}
          onChange={upsert}
        />
      </main>
    </>
  );
}
